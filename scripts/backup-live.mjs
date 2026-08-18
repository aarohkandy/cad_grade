import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processData, readArgs, readJsonl, timestampSlug } from "./analysis-core.mjs";

const VOTE_PREFIX = "votes/v1";
const PROTECTED_PREFIXES = ["derived/v1/", "session-pairs/v1/"];
const REMOTE_PRUNE_BATCH = 200;

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export async function loadEnvFile(path = ".env.local") {
  if (!existsSync(path)) return false;
  const text = await readFile(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = parseEnvValue(trimmed.slice(index + 1));
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function deploymentUrl(value) {
  if (!value) return "";
  if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, "");
  return `https://${value.replace(/\/+$/, "")}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function parseJsonBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null; // a proxy or platform error page is not JSON; callers fall back to the raw text
  }
}

async function fetchJsonBestEffort(url, errors) {
  try {
    return await fetchJson(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Continuing without ${url}: ${message}`);
    errors.push(message);
    return null;
  }
}

// Does not throw on a non-2xx: /api/prune-votes answers 500 for a partial failure and lists
// what it did delete in the same body.
async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text, body: parseJsonBody(text) };
}

function dayKey(value) {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : "unknown";
}

function voteKey(vote) {
  return vote.id || vote.storage?.path || JSON.stringify(vote.raw_payload || vote);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function walkFiles(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(root, entry.name);
      if (entry.isDirectory()) return walkFiles(fullPath);
      return [fullPath];
    }),
  );
  return nested.flat();
}

async function readExistingDailyVotes(dailyRoot) {
  const files = (await walkFiles(dailyRoot)).filter((path) => basename(path).match(/^votes-\d{4}-\d{2}-\d{2}\.jsonl$/));
  const map = new Map();
  for (const file of files) {
    for (const vote of await readJsonl(file)) {
      map.set(voteKey(vote), vote);
    }
  }
  return map;
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

export function completedHourCutoff(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
}

export function isProtectedBlobPath(pathname) {
  return (
    !String(pathname || "").startsWith(`${VOTE_PREFIX}/`) ||
    PROTECTED_PREFIXES.some((prefix) => String(pathname || "").startsWith(prefix))
  );
}

export function pruneCandidatesForCompletedHour(records, now = new Date()) {
  const cutoff = completedHourCutoff(now).toISOString();
  return records
    .filter((record) => !isProtectedBlobPath(record.pathname))
    .filter((record) => String(record.vote.created_at || "") < cutoff)
    .sort((left, right) => String(left.vote.created_at).localeCompare(String(right.vote.created_at)));
}

export function verifyPruneSafety({ candidates, snapshotVotes, dailyVotes }) {
  const snapshotKeys = new Set(snapshotVotes.map(voteKey));
  const dailyKeys = new Set(dailyVotes.map(voteKey));
  const failures = [];
  for (const candidate of candidates) {
    const key = voteKey(candidate.vote);
    if (isProtectedBlobPath(candidate.pathname)) failures.push(`${candidate.pathname}: protected path`);
    if (!snapshotKeys.has(key)) failures.push(`${candidate.pathname}: missing from snapshot`);
    if (!dailyKeys.has(key)) failures.push(`${candidate.pathname}: missing from daily archive`);
  }
  return { ok: failures.length === 0, failures };
}

export async function mergeDailyVotes(outRoot, votes) {
  const dailyRoot = join(outRoot, "daily");
  const existing = await readExistingDailyVotes(dailyRoot);
  const beforeCount = existing.size;
  for (const vote of votes) {
    existing.set(voteKey(vote), vote);
  }

  const byDay = new Map();
  for (const vote of [...existing.values()].sort((left, right) =>
    String(left.created_at).localeCompare(String(right.created_at)),
  )) {
    const day = dayKey(vote.created_at);
    const rows = byDay.get(day) || [];
    rows.push(vote);
    byDay.set(day, rows);
  }

  const dailyFiles = [];
  for (const [day, rows] of byDay.entries()) {
    const path = join(dailyRoot, `votes-${day}.jsonl`);
    await writeJsonl(path, rows);
    dailyFiles.push(path);
  }

  const indexPath = join(outRoot, "index", "seen-vote-ids.json");
  await writeJson(indexPath, {
    updatedAtUtc: new Date().toISOString(),
    voteCount: existing.size,
    voteIds: [...existing.keys()].sort(),
  });

  return {
    dailyRoot,
    dailyFiles: dailyFiles.sort(),
    indexPath,
    totalDailyVotes: existing.size,
    newVotesAdded: existing.size - beforeCount,
    dailyVotes: [...existing.values()],
  };
}

export async function writeBackupFiles({
  outRoot,
  baseUrl,
  health,
  stats,
  records,
  exportPayload = null,
  endpointErrors = [],
  now = new Date(),
}) {
  const day = now.toISOString().slice(0, 10);
  const time = timestampSlug(now).slice(11);
  const snapshotDir = join(outRoot, day, time);
  const votes = records
    .map((record) => record.vote)
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));

  await mkdir(snapshotDir, { recursive: true });
  await writeJson(join(snapshotDir, "health.json"), health);
  await writeJson(join(snapshotDir, "stats.json"), stats);
  if (exportPayload) await writeJson(join(snapshotDir, "export.json"), exportPayload);
  await writeJsonl(join(snapshotDir, "votes.jsonl"), votes);

  const daily = await mergeDailyVotes(outRoot, votes);
  const fileHashes = {
    "health.json": await sha256File(join(snapshotDir, "health.json")),
    "stats.json": await sha256File(join(snapshotDir, "stats.json")),
    "votes.jsonl": await sha256File(join(snapshotDir, "votes.jsonl")),
  };
  if (exportPayload) {
    fileHashes["export.json"] = await sha256File(join(snapshotDir, "export.json"));
  }

  const manifest = {
    generatedAtUtc: now.toISOString(),
    baseUrl,
    outRoot,
    snapshotDir,
    pulledVoteCount: votes.length,
    summaryVoteCount:
      exportPayload?.summaryVoteCount ?? exportPayload?.summary?.totalVotes ?? stats?.totalVotes ?? null,
    acceptedVoteCount:
      exportPayload?.acceptedVoteCount ?? exportPayload?.summary?.acceptedVotes ?? stats?.acceptedVotes ?? null,
    dailyVoteCount: daily.totalDailyVotes,
    newVotesAdded: daily.newVotesAdded,
    fileHashes,
    endpointErrors,
    blobPaths: records.map((record) => record.pathname).sort(),
  };
  await writeJson(join(snapshotDir, "manifest.json"), manifest);

  return {
    snapshotDir,
    votes,
    dailyVotes: daily.dailyVotes,
    manifest,
  };
}

async function readBlobVote(pathname) {
  const { get } = await import("@vercel/blob");
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result?.stream) return null;
  const text = await new Response(result.stream).text();
  return JSON.parse(text);
}

export async function listVoteRecordsFromBlob({ prefix = VOTE_PREFIX } = {}) {
  const { list } = await import("@vercel/blob");
  const records = [];
  let cursor;
  do {
    const page = await list({ prefix, limit: 1000, cursor });
    const rows = await Promise.all(
      page.blobs.map(async (blob) => {
        const vote = await readBlobVote(blob.pathname);
        return vote
          ? {
              vote,
              pathname: blob.pathname,
              uploadedAt: blob.uploadedAt?.toISOString?.() || String(blob.uploadedAt || ""),
            }
          : null;
      }),
    );
    records.push(...rows.filter(Boolean));
    cursor = page.cursor;
  } while (cursor);
  return records.sort((left, right) => String(left.vote.created_at).localeCompare(String(right.vote.created_at)));
}

export async function fetchExportPayload({ baseUrl, limit = 100_000 } = {}) {
  if (!baseUrl) throw new Error("listVoteRecordsFromExport requires baseUrl");
  const url = new URL("/api/export", baseUrl);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  return fetchJson(url);
}

export function recordsFromExportPayload(payload) {
  const votes = Array.isArray(payload?.votes) ? payload.votes : [];
  return votes
    .map((vote) => ({
      vote,
      pathname: vote.storage?.path || `export/${vote.id || vote.created_at || "unknown"}.json`,
      uploadedAt: vote.created_at || "",
    }))
    .sort((left, right) => String(left.vote.created_at).localeCompare(String(right.vote.created_at)));
}

export async function listVoteRecordsFromExport({ baseUrl, limit = 100_000 } = {}) {
  return recordsFromExportPayload(await fetchExportPayload({ baseUrl, limit }));
}

async function deleteBlobPaths(paths) {
  const { del } = await import("@vercel/blob");
  const deleted = [];
  const failed = [];
  for (let index = 0; index < paths.length; index += 100) {
    const chunk = paths.slice(index, index + 100);
    try {
      await del(chunk);
      deleted.push(...chunk);
    } catch (error) {
      failed.push({ paths: chunk, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, failed };
}

export async function deleteRemoteVotePaths({ baseUrl, paths }) {
  if (!paths.length) return { deleted: [], failed: [] };
  const secret = process.env.PRUNE_SECRET;
  if (!secret) {
    throw new Error(
      `Cannot prune ${paths.length} remote vote path(s): PRUNE_SECRET is not set. Put the deployment's prune secret in .env.local, or run with --prune none to keep the blobs.`,
    );
  }
  const url = new URL("/api/prune-votes", baseUrl);
  const deleted = [];
  const failed = [];
  // The endpoint caps how many paths it reads per call and has to finish inside the function
  // timeout, so send the backlog in slices rather than one request that half-succeeds.
  for (let index = 0; index < paths.length; index += REMOTE_PRUNE_BATCH) {
    const chunk = paths.slice(index, index + REMOTE_PRUNE_BATCH);
    const failedBefore = failed.length;
    let response;
    try {
      response = await postJson(url, { paths: chunk }, { "x-prune-secret": secret });
    } catch (error) {
      failed.push({ paths: chunk, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const batchDeleted = Array.isArray(response.body?.deleted)
      ? response.body.deleted.filter((path) => typeof path === "string")
      : [];
    deleted.push(...batchDeleted);
    if (Array.isArray(response.body?.failed)) failed.push(...response.body.failed);

    // The deployment re-filters against its own clock and still answers 200 for what it
    // rejected, so anything back in neither list is still live and counts as a failure.
    const accounted = new Set(batchDeleted);
    for (const entry of Array.isArray(response.body?.failed) ? response.body.failed : []) {
      for (const path of Array.isArray(entry?.paths) ? entry.paths : []) accounted.add(path);
    }
    const unaccounted = chunk.filter((path) => !accounted.has(path));
    if (unaccounted.length) {
      failed.push({
        paths: unaccounted,
        error: response.ok
          ? `Deployment neither deleted nor reported ${unaccounted.length} of ${chunk.length} path(s)`
          : `${url} failed with ${response.status}: ${response.text}`,
      });
    } else if (!response.ok && failed.length === failedBefore) {
      failed.push({ paths: [], error: `${url} failed with ${response.status}: ${response.text}` });
    }
  }
  return { deleted, failed };
}

export async function backupLive({
  baseUrl,
  outRoot = join("exports", "live-backups"),
  prune = "none",
  dryRunPrune = false,
  shouldProcess = true,
  loadEnv = true,
  now = new Date(),
} = {}) {
  if (!baseUrl) throw new Error("backupLive requires baseUrl");
  // loadEnvFile fills in any key that is currently undefined, so a caller that cleared
  // BLOB_READ_WRITE_TOKEN gets it back and reaches del(). Tests pass loadEnv: false.
  if (loadEnv) await loadEnvFile();
  let source = "blob";
  let records;
  let exportPayload = null;
  try {
    records = await listVoteRecordsFromBlob();
  } catch (error) {
    source = "export";
    console.warn(
      `Blob pull failed; falling back to /api/export: ${error instanceof Error ? error.message : String(error)}`,
    );
    exportPayload = await fetchExportPayload({ baseUrl });
    records = recordsFromExportPayload(exportPayload);
    // /api/export skips a stored record it cannot parse rather than failing the pull, so
    // this backup is short by that many votes and no one would otherwise know.
    if (exportPayload?.unreadableCount) {
      console.warn(
        `/api/export skipped ${exportPayload.unreadableCount} unreadable record(s); this backup is incomplete.`,
      );
    }
  }
  const endpointErrors = [];
  const health = await fetchJsonBestEffort(new URL("/api/health", baseUrl), endpointErrors);
  const stats = await fetchJsonBestEffort(new URL("/api/stats", baseUrl), endpointErrors);
  const backup = await writeBackupFiles({
    outRoot,
    baseUrl,
    health,
    stats,
    records,
    exportPayload,
    endpointErrors,
    now,
  });

  const pruneCandidates = prune === "completed-hour" ? pruneCandidatesForCompletedHour(records, now) : [];
  const safety = verifyPruneSafety({
    candidates: pruneCandidates,
    snapshotVotes: backup.votes,
    dailyVotes: backup.dailyVotes,
  });

  let pruneResult = { deleted: [], failed: [] };
  if (pruneCandidates.length && !safety.ok) {
    await writeJson(join(backup.snapshotDir, "prune-manifest.json"), {
      mode: prune,
      dryRun: dryRunPrune,
      ok: false,
      candidates: pruneCandidates.map((record) => record.pathname),
      failures: safety.failures,
      deleted: [],
      failed: [],
    });
    throw new Error(`Refusing to prune: ${safety.failures.join("; ")}`);
  }

  if (pruneCandidates.length && !dryRunPrune) {
    const prunePaths = pruneCandidates.map((record) => record.pathname);
    try {
      pruneResult =
        source === "blob"
          ? await deleteBlobPaths(prunePaths)
          : await deleteRemoteVotePaths({ baseUrl, paths: prunePaths });
    } catch (error) {
      pruneResult = {
        deleted: [],
        failed: [{ paths: prunePaths, error: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  await writeJson(join(backup.snapshotDir, "prune-manifest.json"), {
    mode: prune,
    dryRun: dryRunPrune,
    ok: safety.ok,
    currentUtcHour: completedHourCutoff(now).toISOString(),
    candidates: pruneCandidates.map((record) => record.pathname),
    deleted: pruneResult.deleted,
    failed: pruneResult.failed,
  });

  let processing = null;
  if (shouldProcess) {
    processing = await processData({ backupRoot: outRoot, outRoot: join("exports", "analysis"), now });
  }

  if (pruneResult.failed.length) {
    const firstFailure = pruneResult.failed[0]?.error;
    throw new Error(
      [
        `Prune failed for ${pruneResult.failed.length} chunk(s); see ${join(backup.snapshotDir, "prune-manifest.json")}`,
        firstFailure ? `First failure: ${firstFailure}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    ...backup,
    source,
    recordCount: records.length,
    pruneCandidates: pruneCandidates.length,
    deletedCount: pruneResult.deleted.length,
    processing,
  };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const baseUrl = deploymentUrl(
    args.url || process.env.CAPYBARA_ARENA_URL || process.env.VERCEL_URL || "https://cadbattle.vercel.app",
  );
  const outRoot = args.out || join("exports", "live-backups");
  const prune = args.prune || "none";
  const dryRunPrune = args["dry-run-prune"] === "true";
  const shouldProcess = args.process !== "false" && args["no-process"] !== "true";

  const result = await backupLive({
    baseUrl,
    outRoot,
    prune,
    dryRunPrune,
    shouldProcess,
  });

  console.log(`url=${baseUrl}`);
  console.log(`snapshot=${resolve(result.snapshotDir)}`);
  console.log(`source=${result.source}`);
  console.log(`pulled_votes=${result.recordCount}`);
  if (result.manifest.summaryVoteCount !== null && result.manifest.summaryVoteCount !== undefined) {
    console.log(`summary_votes=${result.manifest.summaryVoteCount}`);
  }
  console.log(`daily_votes=${result.manifest.dailyVoteCount}`);
  for (const problem of result.manifest.endpointErrors) console.log(`degraded=${problem}`);
  console.log(`prune_candidates=${result.pruneCandidates}`);
  console.log(`deleted=${result.deletedCount}`);
  if (result.processing) console.log(`analysis=${result.processing.latestDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
