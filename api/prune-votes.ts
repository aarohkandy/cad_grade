import { timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { methodAllowed, noStore, readJsonBody } from "../src/server/http.js";
import { completedUtcHour, prunableRawVotePaths } from "../src/server/prune.js";
import { storageConfigured } from "../src/server/voteStore.js";

const MAX_PATHS_PER_REQUEST = 1000;
const SECRET_HEADER = "x-prune-secret";

function secretMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

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

/**
 * Deletes raw vote blobs that a backup run has already archived locally. This is
 * the only endpoint that destroys collected data, so it authenticates before it
 * reads the body: with no PRUNE_SECRET configured it deletes nothing at all.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["POST"])) return;

  const secret = process.env.PRUNE_SECRET || "";
  if (!secret) {
    res.status(503).json({ error: "prune_not_configured" });
    return;
  }

  const header = req.headers[SECRET_HEADER];
  const presented = Array.isArray(header) ? header[0] : header;
  if (!presented || !secretMatches(presented, secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  if (!storageConfigured()) {
    res.status(503).json({ error: "vote_storage_not_configured" });
    return;
  }

  try {
    const payload = readJsonBody<{ paths?: unknown }>(req);
    const submittedPaths = Array.isArray(payload.paths)
      ? payload.paths.filter((path): path is string => typeof path === "string")
      : [];
    // Anything past the cap is ignored, not deleted, so say how much was dropped.
    const acceptedPaths = submittedPaths.slice(0, MAX_PATHS_PER_REQUEST);
    const candidates = prunableRawVotePaths(acceptedPaths);
    const result = candidates.length ? await deleteBlobPaths(candidates) : { deleted: [], failed: [] };

    res.status(result.failed.length ? 500 : 200).json({
      requestedCount: submittedPaths.length,
      skippedCount: submittedPaths.length - acceptedPaths.length,
      candidateCount: candidates.length,
      deletedCount: result.deleted.length,
      deleted: result.deleted,
      failed: result.failed,
      currentUtcHour: completedUtcHour().toISOString(),
    });
  } catch (error) {
    console.error("prune-votes failed:", error);
    res.status(500).json({ error: "prune_failed" });
  }
}
