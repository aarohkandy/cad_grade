import type { VercelRequest, VercelResponse } from "@vercel/node";
import { methodAllowed, noStore, readJsonBody } from "../src/server/http.js";
import { completedUtcHour, prunableRawVotePaths } from "../src/server/prune.js";
import { storageConfigured } from "../src/server/voteStore.js";

const MAX_PATHS_PER_REQUEST = 1000;

async function deleteBlobPaths(paths: string[]) {
  const { del } = await import("@vercel/blob");
  const deleted: string[] = [];
  const failed: Array<{ paths: string[]; error: string }> = [];
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["POST"])) return;

  if (!storageConfigured()) {
    res.status(503).json({ error: "vote_storage_not_configured" });
    return;
  }

  try {
    const payload = readJsonBody<{ paths?: unknown }>(req);
    const requestedPaths = Array.isArray(payload.paths)
      ? payload.paths.filter((path): path is string => typeof path === "string").slice(0, MAX_PATHS_PER_REQUEST)
      : [];
    const candidates = prunableRawVotePaths(requestedPaths);
    const result = candidates.length ? await deleteBlobPaths(candidates) : { deleted: [], failed: [] };

    res.status(result.failed.length ? 500 : 200).json({
      requestedCount: requestedPaths.length,
      candidateCount: candidates.length,
      deletedCount: result.deleted.length,
      deleted: result.deleted,
      failed: result.failed,
      currentUtcHour: completedUtcHour().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: "prune_failed", message: error instanceof Error ? error.message : String(error) });
  }
}
