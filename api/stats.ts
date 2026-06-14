import type { VercelRequest, VercelResponse } from "@vercel/node";
import { dataset, familyLabels } from "../src/server/items.js";
import { methodAllowed, noStore } from "../src/server/http.js";
import { readVoteSummary, storageMode } from "../src/server/voteStore.js";
import type { PublicStats } from "../src/shared/types";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;

  const familyRows = dataset.families.map((family) => ({
    family,
    label: familyLabels[family],
    itemCount: dataset.items.filter((item) => item.family === family).length,
    voteCount: 0,
  }));

  try {
    const summary = await readVoteSummary(dataset.datasetId, dataset.families);
    const payload: PublicStats = {
      datasetId: dataset.datasetId,
      itemCount: dataset.itemCount,
      totalVotes: summary.totalVotes,
      acceptedVotes: summary.acceptedVotes,
      families: familyRows.map((row) => ({
        ...row,
        voteCount: summary.families[row.family]?.acceptedVotes || 0,
      })),
      dataMode: storageMode() === "blob" ? "live" : "local",
    };
    res.status(200).json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "stats_failed";
    res.status(500).json({ error: "stats_failed", message });
  }
}
