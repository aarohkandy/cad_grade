import type { VercelRequest, VercelResponse } from "@vercel/node";
import { toCsv } from "../src/server/export";
import { bearerOrHeaderToken, firstQueryValue, methodAllowed, noStore } from "../src/server/http";
import { getSupabase } from "../src/server/supabase";

const TABLES = ["votes", "item_stats", "pair_stats"] as const;
type ExportTable = (typeof TABLES)[number];

function tableFromQuery(value: string | undefined): ExportTable {
  return TABLES.includes(value as ExportTable) ? (value as ExportTable) : "votes";
}

async function fetchTable(table: ExportTable) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("supabase_not_configured");
  const orderColumn = table === "votes" ? "created_at" : "updated_at";
  const { data, error } = await supabase.from(table).select("*").order(orderColumn, { ascending: false });
  if (error) throw error;
  return (data || []) as Array<Record<string, unknown>>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;

  const adminToken = process.env.ADMIN_EXPORT_TOKEN;
  if (!adminToken) {
    res.status(503).json({ error: "admin_export_not_configured" });
    return;
  }
  if (bearerOrHeaderToken(req) !== adminToken) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const format = firstQueryValue(req.query.format) === "csv" ? "csv" : "json";
    if (format === "csv") {
      const table = tableFromQuery(firstQueryValue(req.query.table));
      const rows = await fetchTable(table);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${table}.csv"`);
      res.status(200).send(toCsv(rows));
      return;
    }
    const [votes, itemStats, pairStats] = await Promise.all([
      fetchTable("votes"),
      fetchTable("item_stats"),
      fetchTable("pair_stats"),
    ]);
    res.status(200).json({
      exportedAtUtc: new Date().toISOString(),
      votes,
      item_stats: itemStats,
      pair_stats: pairStats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "export_failed";
    res.status(500).json({ error: "export_failed", message });
  }
}
