import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isVercelRuntime, missingProductionEnv, storageReadyForPublicTraffic } from "../src/server/env.js";
import { dataset } from "../src/server/items.js";
import { methodAllowed, noStore } from "../src/server/http.js";
import { readVoteSummary, storageMode } from "../src/server/voteStore.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;

  const mode = storageMode();
  let storage: "ok" | "not_configured" | "error" = mode === "unconfigured" ? "not_configured" : "ok";

  if (mode !== "unconfigured") {
    try {
      await readVoteSummary(dataset.datasetId, dataset.families);
    } catch (error) {
      // This route is public and unauthenticated, so the cause goes to the log and the caller
      // gets the code, same as /api/stats and /api/export.
      console.error("health: stored summary unreadable:", error);
      storage = "error";
    }
  }
  const runtime = isVercelRuntime() ? "vercel" : "local";
  const missingEnv = runtime === "vercel" ? missingProductionEnv() : [];
  const ready = storage !== "error" && storageReadyForPublicTraffic(mode);

  res.status(storage === "error" ? 503 : 200).json({
    ok: storage !== "error",
    ready,
    app: "capybara-arena",
    datasetId: dataset.datasetId,
    itemCount: dataset.itemCount,
    storage,
    storageMode: mode,
    runtime,
    vercelEnv: process.env.VERCEL_ENV || null,
    missingEnv,
  });
}
