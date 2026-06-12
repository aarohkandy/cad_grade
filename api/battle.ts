import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHoldChallenge } from "../src/server/hold";
import { activeItems, chooseFamily, dataset, itemsForFamily, publicItem } from "../src/server/items";
import { battleId, selectBattlePair, type ItemStatLike, type PairStatLike } from "../src/server/pairs";
import { firstQueryValue, methodAllowed, noStore } from "../src/server/http";
import { readVoteSummary, storageMode } from "../src/server/voteStore";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;

  const family = chooseFamily(firstQueryValue(req.query.family));
  const familyItems = itemsForFamily(family);
  if (familyItems.length < 2) {
    res.status(404).json({ error: "not_enough_items" });
    return;
  }

  const seenPairs = String(firstQueryValue(req.query.seen_pairs) || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 500);
  const votedPairKeys = new Set(seenPairs);
  const itemStats = new Map<string, ItemStatLike>();
  const pairStats = new Map<string, PairStatLike>();

  try {
    const summary = await readVoteSummary(dataset.datasetId, dataset.families);
    for (const stat of Object.values(summary.itemStats)) {
      itemStats.set(stat.item_id, stat);
    }
    for (const pair of Object.values(summary.pairStats)) {
      if (pair.family === family) pairStats.set(pair.pair_key, pair);
    }
  } catch {
    itemStats.clear();
    pairStats.clear();
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
      dataMode: storageMode() === "blob" ? "live" : "local",
    },
  });
}
