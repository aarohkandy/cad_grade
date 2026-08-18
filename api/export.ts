import type { VercelRequest, VercelResponse } from "@vercel/node";
import { toCsv } from "../src/server/export.js";
import { firstQueryValue, methodAllowed, noStore } from "../src/server/http.js";
import { dataset, itemById } from "../src/server/items.js";
import { loadVoteRecords, readVoteSummary, storageConfigured, summaryFromVotes } from "../src/server/voteStore.js";

const TABLES = ["votes", "item_stats", "pair_stats", "quality_flags"] as const;
type ExportTable = (typeof TABLES)[number];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 10_000;

function tableFromQuery(value: string | undefined): ExportTable {
  return TABLES.includes(value as ExportTable) ? (value as ExportTable) : "votes";
}

function limitFromQuery(value: string | undefined): number | null {
  if (!value) return DEFAULT_LIMIT;
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

function richerSummary(
  rawSummary: ReturnType<typeof summaryFromVotes>,
  storedSummary: Awaited<ReturnType<typeof readVoteSummary>>,
) {
  return storedSummary.totalVotes >= rawSummary.totalVotes ? storedSummary : rawSummary;
}

function rowsForTable(
  table: ExportTable,
  votes: Awaited<ReturnType<typeof loadVoteRecords>>["records"],
  summary: ReturnType<typeof summaryFromVotes>,
) {
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

  // An empty ?date= means no date filter, the way an empty ?limit= means the default.
  const date = firstQueryValue(req.query.date);
  if (date && !DATE_PATTERN.test(date)) {
    res.status(400).json({ error: "invalid_date" });
    return;
  }

  const limit = limitFromQuery(firstQueryValue(req.query.limit));
  if (limit === null) {
    res.status(400).json({ error: "invalid_limit" });
    return;
  }

  try {
    const { records: votes, unreadableCount } = await loadVoteRecords({ date, limit });
    const format = firstQueryValue(req.query.format) === "csv" ? "csv" : "json";
    const table = tableFromQuery(firstQueryValue(req.query.table));
    const rawSummary = summaryFromVotes(dataset.datasetId, dataset.families, votes, itemById);
    // An unreadable stored summary should cost the derived stats, not the votes the backup
    // script came here for.
    let summaryAvailable = true;
    let summary = rawSummary;
    try {
      summary = richerSummary(rawSummary, await readVoteSummary(dataset.datasetId, dataset.families));
    } catch (error) {
      console.error("export: stored summary unavailable, deriving stats from raw votes", error);
      summaryAvailable = false;
    }

    if (format === "csv") {
      const rows = rowsForTable(table, votes, summary);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${table}.csv"`);
      res.status(200).send(toCsv(rows as Array<Record<string, unknown>>));
      return;
    }

    res.status(200).json({
      exportedAtUtc: new Date().toISOString(),
      date: date || null,
      voteCount: votes.length,
      rawVoteCount: votes.length,
      unreadableCount,
      summaryAvailable,
      summaryVoteCount: summary.totalVotes,
      acceptedVoteCount: summary.acceptedVotes,
      mixedVoteCount: summary.mixedVotes || 0,
      mixedAcceptedVoteCount: summary.mixedAcceptedVotes || 0,
      votes,
      summary: {
        version: summary.version,
        datasetId: summary.datasetId,
        updatedAtUtc: summary.updatedAtUtc,
        totalVotes: summary.totalVotes,
        acceptedVotes: summary.acceptedVotes,
        mixedVotes: summary.mixedVotes || 0,
        mixedAcceptedVotes: summary.mixedAcceptedVotes || 0,
        families: summary.families,
        qualityFlagCounts: summary.qualityFlagCounts,
      },
      item_stats: Object.values(summary.itemStats),
      pair_stats: Object.values(summary.pairStats),
      quality_flags: summary.qualityFlagCounts,
    });
  } catch (error) {
    console.error("export: read failed", error);
    res.status(500).json({ error: "export_failed" });
  }
}
