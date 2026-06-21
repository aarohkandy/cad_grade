import type { VercelRequest, VercelResponse } from "@vercel/node";
import { toCsv } from "../src/server/export.js";
import { firstQueryValue, methodAllowed, noStore } from "../src/server/http.js";
import { dataset, itemById } from "../src/server/items.js";
import { readVoteRecords, storageConfigured, summaryFromVotes } from "../src/server/voteStore.js";

const TABLES = ["votes", "item_stats", "pair_stats", "quality_flags"] as const;
type ExportTable = (typeof TABLES)[number];

function tableFromQuery(value: string | undefined): ExportTable {
  return TABLES.includes(value as ExportTable) ? (value as ExportTable) : "votes";
}

function rowsForTable(table: ExportTable, votes: Awaited<ReturnType<typeof readVoteRecords>>) {
  const summary = summaryFromVotes(dataset.datasetId, dataset.families, votes, itemById);
  if (table === "item_stats") return Object.values(summary.itemStats);
  if (table === "pair_stats") return Object.values(summary.pairStats);
  if (table === "quality_flags") {
    return Object.entries(summary.qualityFlagCounts).map(([flag, count]) => ({ flag, count }));
  }
  return votes;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;

  if (!storageConfigured()) {
    res.status(503).json({ error: "vote_storage_not_configured" });
    return;
  }

  try {
    const date = firstQueryValue(req.query.date);
    const limit = Number(firstQueryValue(req.query.limit) || 10_000);
    const votes = await readVoteRecords({ date, limit });
    const format = firstQueryValue(req.query.format) === "csv" ? "csv" : "json";
    const table = tableFromQuery(firstQueryValue(req.query.table));

    if (format === "csv") {
      const rows = rowsForTable(table, votes);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${table}.csv"`);
      res.status(200).send(toCsv(rows as Array<Record<string, unknown>>));
      return;
    }

    const summary = summaryFromVotes(dataset.datasetId, dataset.families, votes, itemById);
    res.status(200).json({
      exportedAtUtc: new Date().toISOString(),
      date: date || null,
      voteCount: votes.length,
      mixedVoteCount: summary.mixedVotes || 0,
      mixedAcceptedVoteCount: summary.mixedAcceptedVotes || 0,
      votes,
      item_stats: Object.values(summary.itemStats),
      pair_stats: Object.values(summary.pairStats),
      quality_flags: summary.qualityFlagCounts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "export_failed";
    res.status(500).json({ error: "export_failed", message });
  }
}
