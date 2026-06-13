import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  BlobNotFoundError,
  BlobPreconditionFailedError,
  get,
  head,
  list,
  put,
} from "@vercel/blob";
import { updateElo } from "./elo";
import { pairKey } from "./pairs";
import type { ArenaFamily, ArenaItem } from "../shared/types";

export const VOTES_PREFIX = "votes/v1";
export const SESSION_PAIR_PREFIX = "session-pairs/v1";
export const SUMMARY_PATH = "derived/v1/stats-summary.json";

const SUMMARY_VERSION = 1;

export type StorageMode = "blob" | "local" | "unconfigured";

export interface StoredVoteRecord {
  id: string;
  created_at: string;
  dataset_id: string;
  battle_id: string;
  family: ArenaFamily;
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
  family: ArenaFamily;
  item_a_id: string;
  item_b_id: string;
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
  families: Record<ArenaFamily, FamilySummary>;
  itemStats: Record<string, StoredItemStat>;
  pairStats: Record<string, StoredPairStat>;
  qualityFlagCounts: Record<string, number>;
}

interface SummaryReadResult {
  summary: VoteSummary | null;
  etag?: string;
}

export function storageMode(): StorageMode {
  if (process.env.BLOB_READ_WRITE_TOKEN || (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID)) {
    return "blob";
  }
  if (process.env.LOCAL_VOTE_DIR || !process.env.VERCEL) return "local";
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

export function sessionPairPath(sessionHash: string, family: ArenaFamily, leftId: string, rightId: string): string {
  return `${SESSION_PAIR_PREFIX}/${sessionHash}/${family}/${pairKey(leftId, rightId)}.json`;
}

function defaultItemStat(item: ArenaItem, updatedAt: string): StoredItemStat {
  return {
    item_id: item.id,
    family: item.family,
    elo: 1200,
    wins: 0,
    losses: 0,
    draws: 0,
    battle_count: 0,
    updated_at: updatedAt,
  };
}

function defaultPairStat(family: ArenaFamily, leftId: string, rightId: string, updatedAt: string): StoredPairStat {
  const [itemA, itemB] = [leftId, rightId].sort();
  return {
    pair_key: pairKey(leftId, rightId),
    family,
    item_a_id: itemA,
    item_b_id: itemB,
    item_a_wins: 0,
    item_b_wins: 0,
    draw_count: 0,
    battle_count: 0,
    updated_at: updatedAt,
  };
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
  next.totalVotes += 1;
  next.families[vote.family] ||= {
    family: vote.family,
    totalVotes: 0,
    acceptedVotes: 0,
  };
  next.families[vote.family].totalVotes += 1;

  for (const flag of vote.quality_flags) {
    next.qualityFlagCounts[flag] = (next.qualityFlagCounts[flag] || 0) + 1;
  }

  if (!vote.accepted_for_scoring) return next;

  next.acceptedVotes += 1;
  next.families[vote.family].acceptedVotes += 1;

  const key = pairKey(vote.left_item_id, vote.right_item_id);
  const pair = next.pairStats[key] || defaultPairStat(vote.family, vote.left_item_id, vote.right_item_id, updatedAt);

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
  const elo = updateElo(winnerBefore, loserBefore);

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
    .reduce((summary, vote) => {
      const left = itemLookup(vote.left_item_id);
      const right = itemLookup(vote.right_item_id);
      const winner = vote.winner_item_id ? itemLookup(vote.winner_item_id) || null : null;
      const loser = vote.loser_item_id ? itemLookup(vote.loser_item_id) || null : null;
      return left && right ? applyVoteToSummary(summary, vote, left, right, winner, loser) : summary;
    }, emptySummary(datasetId, families));
}

function isMissingBlob(error: unknown): boolean {
  return error instanceof BlobNotFoundError || (error instanceof Error && /not found|404/i.test(error.message));
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
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: allowOverwrite ? "w" : "wx",
  });
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

async function localJsonByPrefix<T>(prefix: string): Promise<T[]> {
  const prefixPath = localFilePath(prefix);
  const files = await walkLocalFiles(prefixPath);
  const rows = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readFile(file, "utf8")));
  return rows.map((row) => JSON.parse(row) as T);
}

async function readBlobJson<T>(pathname: string): Promise<SummaryReadResult & { value?: T }> {
  try {
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || error instanceof BlobPreconditionFailedError) {
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
      if (error instanceof BlobPreconditionFailedError) continue;
      throw error;
    }
  }

  const current = await readVoteSummary(datasetId, families);
  const next = applyVoteToSummary(current, vote, left, right, winner, loser);
  await writeBlobJson(SUMMARY_PATH, next, { allowOverwrite: true });
  return next;
}

export async function readVoteRecords(options: { date?: string; limit?: number } = {}): Promise<StoredVoteRecord[]> {
  const mode = storageMode();
  if (mode === "unconfigured") return [];
  const prefix = options.date ? `${VOTES_PREFIX}/${options.date}` : VOTES_PREFIX;
  const limit = Math.max(1, Math.min(options.limit || 10_000, 10_000));

  if (mode === "local") {
    return (await localJsonByPrefix<StoredVoteRecord>(prefix))
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, limit);
  }

  const records: StoredVoteRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, limit: Math.min(1000, limit - records.length), cursor });
    const rows = await Promise.all(
      page.blobs.map(async (blob) => {
        const result = await readBlobJson<StoredVoteRecord>(blob.pathname);
        return result.value;
      }),
    );
    records.push(...rows.filter((row): row is StoredVoteRecord => Boolean(row)));
    cursor = page.cursor;
  } while (cursor && records.length < limit);

  return records.sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, limit);
}
