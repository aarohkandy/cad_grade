import type { VercelRequest, VercelResponse } from "@vercel/node";
import { dataset, familyLabels } from "../src/server/items";
import { methodAllowed, noStore } from "../src/server/http";
import { getSupabase } from "../src/server/supabase";
import type { ArenaFamily, PublicStats } from "../src/shared/types";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;

  const supabase = getSupabase();
  const familyRows = dataset.families.map((family) => ({
    family,
    label: familyLabels[family],
    itemCount: dataset.items.filter((item) => item.family === family).length,
    voteCount: 0,
  }));

  if (!supabase) {
    const payload: PublicStats = {
      datasetId: dataset.datasetId,
      itemCount: dataset.itemCount,
      totalVotes: 0,
      acceptedVotes: 0,
      families: familyRows,
      dataMode: "demo",
    };
    res.status(200).json(payload);
    return;
  }

  try {
    const { count: totalVotes } = await supabase.from("votes").select("id", { count: "exact", head: true });
    const { count: acceptedVotes } = await supabase
      .from("votes")
      .select("id", { count: "exact", head: true })
      .eq("accepted_for_scoring", true);
    const { data: pairs } = await supabase.from("pair_stats").select("family,battle_count");
    const byFamily = new Map<ArenaFamily, number>();
    for (const pair of (pairs || []) as Array<{ family: ArenaFamily; battle_count: number }>) {
      byFamily.set(pair.family, (byFamily.get(pair.family) || 0) + Number(pair.battle_count || 0));
    }
    const payload: PublicStats = {
      datasetId: dataset.datasetId,
      itemCount: dataset.itemCount,
      totalVotes: totalVotes || 0,
      acceptedVotes: acceptedVotes || 0,
      families: familyRows.map((row) => ({ ...row, voteCount: byFamily.get(row.family) || 0 })),
      dataMode: "live",
    };
    res.status(200).json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "stats_failed";
    res.status(500).json({ error: "stats_failed", message });
  }
}
