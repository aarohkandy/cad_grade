import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHoldChallenge } from "../src/server/hold";
import { activeItems, chooseFamily, dataset, itemsForFamily, publicItem } from "../src/server/items";
import { battleId, pairKey, selectBattlePair, type ItemStatLike, type PairStatLike } from "../src/server/pairs";
import { getSupabase } from "../src/server/supabase";
import { firstQueryValue, methodAllowed, noStore } from "../src/server/http";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;

  const family = chooseFamily(firstQueryValue(req.query.family));
  const familyItems = itemsForFamily(family);
  if (familyItems.length < 2) {
    res.status(404).json({ error: "not_enough_items" });
    return;
  }

  const sessionId = String(firstQueryValue(req.query.session_id) || "").slice(0, 160);
  const votedPairKeys = new Set<string>();
  const itemStats = new Map<string, ItemStatLike>();
  const pairStats = new Map<string, PairStatLike>();
  const supabase = getSupabase();

  if (supabase) {
    try {
      if (sessionId) {
        const { data: votes } = await supabase
          .from("votes")
          .select("left_item_id,right_item_id")
          .eq("session_id", sessionId)
          .eq("family", family)
          .limit(2000);
        for (const vote of (votes || []) as Array<{ left_item_id: string; right_item_id: string }>) {
          votedPairKeys.add(pairKey(vote.left_item_id, vote.right_item_id));
        }
      }

      const itemIds = familyItems.map((item) => item.id);
      const { data: stats } = await supabase
        .from("item_stats")
        .select("item_id,elo,battle_count")
        .in("item_id", itemIds);
      for (const stat of (stats || []) as ItemStatLike[]) {
        itemStats.set(stat.item_id, stat);
      }

      const { data: pairs } = await supabase
        .from("pair_stats")
        .select("pair_key,battle_count")
        .eq("family", family);
      for (const pair of (pairs || []) as PairStatLike[]) {
        pairStats.set(pair.pair_key, pair);
      }
    } catch {
      votedPairKeys.clear();
      itemStats.clear();
      pairStats.clear();
    }
  }

  const [left, right] = selectBattlePair({
    items: familyItems,
    votedPairKeys,
    itemStats,
    pairStats,
  });

  res.status(200).json({
    battleId: battleId(left.id, right.id),
    datasetId: dataset.datasetId,
    family,
    left: publicItem(left),
    right: publicItem(right),
    hold: createHoldChallenge(),
    stats: {
      itemCount: activeItems.length,
      familyItemCount: familyItems.length,
      dataMode: supabase ? "live" : "demo",
    },
  });
}
