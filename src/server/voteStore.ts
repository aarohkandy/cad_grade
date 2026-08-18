import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { eloVoteWeight, initialEloForItem, updateElo } from "./elo.js";
import { hasBlobCredentials, isVercelRuntime } from "./env.js";
import { pairGroup, pairKey } from "./pairs.js";
import { acceptedForCurrentScoring } from "./quality.js";
import type { ArenaFamily, ArenaItem, BattleGroup } from "../shared/types";

export const VOTES_PREFIX = "votes/v1";
export const SESSION_PAIR_PREFIX = "session-pairs/v1";
export const SUMMARY_PATH = "derived/v1/stats-summary.json";

// A blob listing page holds up to 1,000 objects, and reading a page with Promise.all means
// that many concurrent GETs out of one serverless function.
export const VOTE_READ_CONCURRENCY = 24;

const SUMMARY_VERSION = 1;

export type StorageMode = "blob" | "local" | "unconfigured";

export interface StoredVoteRecord {
  id: string;
  created_at: string;
  dataset_id: string;
  battle_id: string;
  family: BattleGroup;
  left_item_id: string;
  right_item_id: string;
  winner_item_id: string | null;
  loser_item_id: string | null;
  vote_result: "winner" | "draw";
  session_id: string;
  started_at: string;
  models_loaded_at: string;
  voted_at: string;
  elapsed_ms: number | null;
  load_ms: number | null;
  hold_duration_ms: number | null;
  hold_target_ms: number | null;
  hold_passed: boolean;
  duplicate_pair: boolean;
  too_fast: boolean;
  accepted_for_scoring: boolean;
  quality_flags: string[];
  ip_hash: string;
  user_agent_hash: string;
  raw_payload: {
    battle_id: string;
    left_item_id: string;
    right_item_id: string;
    winner_item_id: string | null;
    loser_item_id: string | null;
    vote_result: "winner" | "draw";
  };
  storage: {
    mode: StorageMode;
    path: string;
  };
}

export interface StoredItemStat {
  item_id: string;
  family: ArenaFamily;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  battle_count: number;
  updated_at: string;
}

export interface StoredPairStat {
  pair_key: string;
  family: BattleGroup;
  item_a_id: string;
  item_a_family: ArenaFamily;
  item_b_id: string;
  item_b_family: ArenaFamily;
  item_a_wins: number;
  item_b_wins: number;
  draw_count: number;
  battle_count: number;
  updated_at: string;
}

export interface FamilySummary {
  family: ArenaFamily;
  totalVotes: number;
  acceptedVotes: number;
}

export interface VoteSummary {
  version: number;
  datasetId: string;
  updatedAtUtc: string;
  totalVotes: number;
  acceptedVotes: number;
  mixedVotes: number;
  mixedAcceptedVotes: number;
  families: Record<ArenaFamily, FamilySummary>;
  itemStats: Record<string, StoredItemStat>;
  pairStats: Record<string, StoredPairStat>;
  qualityFlagCounts: Record<string, number>;
}

interface SummaryReadResult {
  summary: VoteSummary | null;
  etag?: string;
}

export interface VoteRecordsResult {
  records: StoredVoteRecord[];
  unreadableCount: number;
}

export function storageMode(): StorageMode {
  if (hasBlobCredentials()) return "blob";
  if (!isVercelRuntime()) return "local";
  return "unconfigured";
}

export function storageConfigured(): boolean {
  return storageMode() !== "unconfigured";
}

export function emptySummary(datasetId: string, families: ArenaFamily[]): VoteSummary {
  const familyRows = Object.fromEntries(
    families.map((family) => [
      family,
      {
        family,
        totalVotes: 0,
        acceptedVotes: 0,
      },
    ]),
  ) as Record<ArenaFamily, FamilySummary>;

  return {
    version: SUMMARY_VERSION,
    datasetId,
    updatedAtUtc: new Date(0).toISOString(),
    totalVotes: 0,
    acceptedVotes: 0,
    mixedVotes: 0,
    mixedAcceptedVotes: 0,
    families: familyRows,
    itemStats: {},
    pairStats: {},
    qualityFlagCounts: {},
  };
}

export function votePath(createdAt: string, voteId: string = randomUUID()): string {
  const day = createdAt.slice(0, 10);
  const timestamp = createdAt.replaceAll(":", "-").replaceAll(".", "-");
  return `${VOTES_PREFIX}/${day}/${timestamp}_${voteId}.json`;
}

export function sessionPairPath(sessionHash: string, family: BattleGroup, leftId: string, rightId: string): string {
  return `${SESSION_PAIR_PREFIX}/${sessionHash}/${family}/${pairKey(leftId, rightId)}.json`;
}

function defaultItemStat(item: ArenaItem, updatedAt: string): StoredItemStat {
  return {
    item_id: item.id,
    family: item.family,
    elo: initialEloForItem(item),
    wins: 0,
    losses: 0,
    draws: 0,
    battle_count: 0,
    updated_at: updatedAt,
  };
}

function defaultPairStat(left: ArenaItem, right: ArenaItem, updatedAt: string): StoredPairStat {
  const [itemA, itemB] = [left, right].sort((a, b) => a.id.localeCompare(b.id));
  return {
    pair_key: pairKey(left.id, right.id),
    family: pairGroup(left, right),
    item_a_id: itemA.id,
    item_a_family: itemA.family,
    item_b_id: itemB.id,
    item_b_family: itemB.family,
    item_a_wins: 0,
    item_b_wins: 0,
    draw_count: 0,
    battle_count: 0,
    updated_at: updatedAt,
  };
}

function normalizePairStat(
  pair: StoredPairStat | undefined,
  left: ArenaItem,
  right: ArenaItem,
  updatedAt: string,
): StoredPairStat {
  return {
    ...defaultPairStat(left, right, updatedAt),
    ...pair,
    family: pairGroup(left, right),
  };
}

function incrementFamily(summary: VoteSummary, family: ArenaFamily, key: "totalVotes" | "acceptedVotes"): void {
  summary.families[family] ||= {
    family,
    totalVotes: 0,
    acceptedVotes: 0,
  };
  summary.families[family][key] += 1;
}

function involvedFamilies(left: ArenaItem, right: ArenaItem): ArenaFamily[] {
  return left.family === right.family ? [left.family] : [left.family, right.family];
}

export function applyVoteToSummary(
  summary: VoteSummary,
  vote: StoredVoteRecord,
  left: ArenaItem,
  right: ArenaItem,
  winner: ArenaItem | null,
  loser: ArenaItem | null,
): VoteSummary {
  const next: VoteSummary = structuredClone(summary);
  const updatedAt = vote.created_at;
  next.version = SUMMARY_VERSION;
  next.updatedAtUtc = updatedAt;
  next.mixedVotes ||= 0;
  next.mixedAcceptedVotes ||= 0;
  next.totalVotes += 1;
  const group = pairGroup(left, right);
  if (group === "mixed") next.mixedVotes += 1;
  for (const family of involvedFamilies(left, right)) {
    incrementFamily(next, family, "totalVotes");
  }

  for (const flag of vote.quality_flags) {
    next.qualityFlagCounts[flag] = (next.qualityFlagCounts[flag] || 0) + 1;
  }

  if (!acceptedForCurrentScoring(vote)) return next;

  next.acceptedVotes += 1;
  if (group === "mixed") next.mixedAcceptedVotes += 1;
  for (const family of involvedFamilies(left, right)) {
    incrementFamily(next, family, "acceptedVotes");
  }

  const key = pairKey(vote.left_item_id, vote.right_item_id);
  const pair = normalizePairStat(next.pairStats[key], left, right, updatedAt);

  if (vote.vote_result === "draw" || !winner || !loser) {
    const leftBefore = next.itemStats[left.id] || defaultItemStat(left, updatedAt);
    const rightBefore = next.itemStats[right.id] || defaultItemStat(right, updatedAt);
    next.itemStats[left.id] = {
      ...leftBefore,
      draws: (leftBefore.draws || 0) + 1,
      battle_count: leftBefore.battle_count + 1,
      updated_at: updatedAt,
    };
    next.itemStats[right.id] = {
      ...rightBefore,
      draws: (rightBefore.draws || 0) + 1,
      battle_count: rightBefore.battle_count + 1,
      updated_at: updatedAt,
    };
    next.pairStats[key] = {
      ...pair,
      draw_count: (pair.draw_count || 0) + 1,
      battle_count: pair.battle_count + 1,
      updated_at: updatedAt,
    };
    return next;
  }

  const winnerBefore = next.itemStats[winner.id] || defaultItemStat(winner, updatedAt);
  const loserBefore = next.itemStats[loser.id] || defaultItemStat(loser, updatedAt);
  const elo = updateElo(winnerBefore, loserBefore, {
    weight: eloVoteWeight(winnerBefore, loserBefore),
  });

  next.itemStats[winner.id] = {
    ...winnerBefore,
    elo: elo.winnerElo,
    wins: winnerBefore.wins + 1,
    battle_count: winnerBefore.battle_count + 1,
    updated_at: updatedAt,
  };
  next.itemStats[loser.id] = {
    ...loserBefore,
    elo: elo.loserElo,
    losses: loserBefore.losses + 1,
    battle_count: loserBefore.battle_count + 1,
    updated_at: updatedAt,
  };

  next.pairStats[key] = {
    ...pair,
    item_a_wins: pair.item_a_wins + (vote.winner_item_id === pair.item_a_id ? 1 : 0),
    item_b_wins: pair.item_b_wins + (vote.winner_item_id === pair.item_b_id ? 1 : 0),
    battle_count: pair.battle_count + 1,
    updated_at: updatedAt,
  };

  return next;
}

export function summaryFromVotes(
  datasetId: string,
  families: ArenaFamily[],
  votes: StoredVoteRecord[],
  itemLookup: (id: string) => ArenaItem | undefined,
): VoteSummary {
  return [...votes]
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .reduce(
      (summary, vote) => {
        const left = itemLookup(vote.left_item_id);
        const right = itemLookup(vote.right_item_id);
        const winner = vote.winner_item_id ? itemLookup(vote.winner_item_id) || null : null;
        const loser = vote.loser_item_id ? itemLookup(vote.loser_item_id) || null : null;
        return left && right ? applyVoteToSummary(summary, vote, left, right, winner, loser) : summary;
      },
      emptySummary(datasetId, families),
    );
}

let blobModule: Promise<typeof import("@vercel/blob")> | null = null;

// Reading a page of votes asks for the client once per object, and a dynamic import per
// blob GET is pure overhead once the module is resolved. A failed load is dropped rather
// than cached — a rejected promise is truthy, so keeping it would make one bad import
// break every later read in this instance.
async function blobClient() {
  blobModule ||= import("@vercel/blob").catch((error) => {
    blobModule = null;
    throw error;
  });
  return blobModule;
}

function isMissingBlob(error: unknown): boolean {
  return error instanceof Error && /not found|does not exist|404/i.test(error.message);
}

function isBlobPreconditionFailed(error: unknown): boolean {
  return error instanceof Error && /precondition|if-?match|already exists|412/i.test(error.message);
}

function localRoot(): string {
  return resolve(process.env.LOCAL_VOTE_DIR || join(process.cwd(), ".local-data", "blob"));
}

function localFilePath(pathname: string): string {
  const normalized = pathname.replaceAll("\\", "/").replace(/^\/+/, "");
  const resolved = resolve(localRoot(), normalized);
  const root = `${localRoot()}${sep}`;
  if (resolved !== localRoot() && !resolved.startsWith(root)) {
    throw new Error("unsafe_local_storage_path");
  }
  return resolved;
}

async function readLocalJson<T>(pathname: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(localFilePath(pathname), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeLocalJson(pathname: string, value: unknown, allowOverwrite: boolean): Promise<void> {
  const filePath = localFilePath(pathname);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  if (!allowOverwrite) {
    await writeFile(filePath, body, { encoding: "utf8", flag: "wx" });
    return;
  }
  // Overwriting in place lets two concurrent local requests interleave and leave one
  // writer's tail after the other's document, which reads back as invalid JSON. Writing
  // a private file and renaming it over the target keeps every reader on a whole one.
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, body, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function walkLocalFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) return walkLocalFiles(fullPath);
      return [fullPath];
    }),
  );
  return paths.flat();
}

async function mapWithLimit<T, R>(items: T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readLocalVoteRecords(prefix: string, limit: number): Promise<VoteRecordsResult> {
  const files = (await walkLocalFiles(localFilePath(prefix))).filter((file) => file.endsWith(".json")).sort();
  // A vote path is votes/v1/<day>/<ISO timestamp>_<uuid>.json, so path order is write
  // order — the same property prune.ts leans on. Taking the tail means the parse cost
  // tracks the limit instead of the size of the store. The limit is therefore a scan
  // bound, not a delivery guarantee: a damaged file inside the tail comes back short
  // rather than reaching further into the store for a replacement.
  const newest = files.slice(Math.max(0, files.length - limit));
  let unreadableCount = 0;

  const rows = await mapWithLimit(newest, VOTE_READ_CONCURRENCY, async (file) => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as StoredVoteRecord;
    } catch (error) {
      console.error(`voteStore: skipping unreadable vote record ${file}`, error);
      unreadableCount += 1;
      return null;
    }
  });

  return { records: rows.filter((row): row is StoredVoteRecord => row !== null), unreadableCount };
}

async function readBlobJson<T>(pathname: string): Promise<SummaryReadResult & { value?: T }> {
  try {
    const { get } = await blobClient();
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return { summary: null };
    const text = await new Response(result.stream).text();
    return {
      summary: null,
      value: JSON.parse(text) as T,
      etag: result.blob.etag,
    };
  } catch (error) {
    if (isMissingBlob(error)) return { summary: null };
    throw error;
  }
}

async function writeBlobJson(pathname: string, value: unknown, options: { allowOverwrite: boolean; ifMatch?: string }) {
  const { put } = await blobClient();
  await put(pathname, JSON.stringify(value, null, 2), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: options.allowOverwrite,
    cacheControlMaxAge: 60,
    contentType: "application/json; charset=utf-8",
    ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
  });
}

export async function readVoteSummary(datasetId: string, families: ArenaFamily[]): Promise<VoteSummary> {
  if (storageMode() === "blob") {
    const result = await readBlobJson<VoteSummary>(SUMMARY_PATH);
    return result.value || emptySummary(datasetId, families);
  }
  if (storageMode() === "local") {
    return (await readLocalJson<VoteSummary>(SUMMARY_PATH)) || emptySummary(datasetId, families);
  }
  return emptySummary(datasetId, families);
}

export async function writeVoteRecord(record: StoredVoteRecord): Promise<void> {
  const mode = storageMode();
  if (mode === "unconfigured") throw new Error("vote_storage_not_configured");
  if (mode === "blob") {
    await writeBlobJson(record.storage.path, record, { allowOverwrite: false });
    return;
  }
  await writeLocalJson(record.storage.path, record, false);
}

export async function sessionPairAlreadySeen(pathname: string): Promise<boolean> {
  const mode = storageMode();
  if (mode === "unconfigured") return false;
  if (mode === "blob") {
    try {
      const { head } = await blobClient();
      await head(pathname);
      return true;
    } catch (error) {
      if (isMissingBlob(error)) return false;
      throw error;
    }
  }
  return (await readLocalJson(pathname)) !== null;
}

export async function markSessionPair(pathname: string, value: unknown): Promise<void> {
  const mode = storageMode();
  if (mode === "unconfigured") return;
  try {
    if (mode === "blob") {
      await writeBlobJson(pathname, value, { allowOverwrite: false });
      return;
    }
    await writeLocalJson(pathname, value, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || isBlobPreconditionFailed(error)) {
      return;
    }
    throw error;
  }
}

export async function updateVoteSummary(
  datasetId: string,
  families: ArenaFamily[],
  vote: StoredVoteRecord,
  left: ArenaItem,
  right: ArenaItem,
  winner: ArenaItem | null,
  loser: ArenaItem | null,
): Promise<VoteSummary> {
  const mode = storageMode();
  if (mode === "unconfigured") throw new Error("vote_storage_not_configured");
  if (mode === "local") {
    const current = (await readLocalJson<VoteSummary>(SUMMARY_PATH)) || emptySummary(datasetId, families);
    const next = applyVoteToSummary(current, vote, left, right, winner, loser);
    await writeLocalJson(SUMMARY_PATH, next, true);
    return next;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await readBlobJson<VoteSummary>(SUMMARY_PATH);
    const current = result.value || emptySummary(datasetId, families);
    const next = applyVoteToSummary(current, vote, left, right, winner, loser);
    try {
      await writeBlobJson(SUMMARY_PATH, next, {
        allowOverwrite: true,
        ...(result.etag ? { ifMatch: result.etag } : {}),
      });
      return next;
    } catch (error) {
      if (isBlobPreconditionFailed(error)) continue;
      throw error;
    }
  }

  const current = await readVoteSummary(datasetId, families);
  const next = applyVoteToSummary(current, vote, left, right, winner, loser);
  await writeBlobJson(SUMMARY_PATH, next, { allowOverwrite: true });
  return next;
}

// One damaged object should cost the vote it holds and nothing else. Every read path here
// skips what it cannot parse and counts it, so /api/export can report the loss instead of
// 500ing and taking the backup loop down with it.
export async function loadVoteRecords(options: { date?: string; limit?: number } = {}): Promise<VoteRecordsResult> {
  const mode = storageMode();
  if (mode === "unconfigured") return { records: [], unreadableCount: 0 };
  const prefix = options.date ? `${VOTES_PREFIX}/${options.date}` : VOTES_PREFIX;
  const limit = Math.max(1, Math.min(options.limit || 10_000, 10_000));

  if (mode === "local") {
    const result = await readLocalVoteRecords(prefix, limit);
    return {
      records: result.records.sort((left, right) => right.created_at.localeCompare(left.created_at)),
      unreadableCount: result.unreadableCount,
    };
  }

  const records: StoredVoteRecord[] = [];
  let unreadableCount = 0;
  let cursor: string | undefined;
  do {
    const { list } = await blobClient();
    const page = await list({ prefix, limit: Math.min(1000, limit - records.length), cursor });
    const rows = await mapWithLimit(page.blobs, VOTE_READ_CONCURRENCY, async (blob) => {
      try {
        return (await readBlobJson<StoredVoteRecord>(blob.pathname)).value;
      } catch (error) {
        console.error(`voteStore: skipping unreadable vote blob ${blob.pathname}`, error);
        unreadableCount += 1;
        return undefined;
      }
    });
    records.push(...rows.filter((row): row is StoredVoteRecord => Boolean(row)));
    cursor = page.cursor;
  } while (cursor && records.length < limit);

  return {
    records: records.sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, limit),
    unreadableCount,
  };
}
