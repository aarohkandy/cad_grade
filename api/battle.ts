import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHoldChallenge } from "../src/server/hold.js";
import { activeItems, dataset, itemsForFamily, normalizeFamily, publicItem } from "../src/server/items.js";
import {
  battleId,
  selectBattleFamily,
  selectBattlePair,
  type ItemStatLike,
  type PairStatLike,
} from "../src/server/pairs.js";
import { firstQueryValue, methodAllowed, noStore } from "../src/server/http.js";
import { readVoteSummary, storageMode } from "../src/server/voteStore.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (!methodAllowed(req, res, ["GET"])) return;

  const requestedFamily = normalizeFamily(firstQueryValue(req.query.family));
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
      pairStats.set(pair.pair_key, pair);
    }
  } catch {
    itemStats.clear();
    pairStats.clear();
  }

  const family =
    requestedFamily === "any"
      ? selectBattleFamily({
          items: activeItems,
          families: dataset.families,
          votedPairKeys,
          itemStats,
          pairStats,
        })
      : requestedFamily;
  const familyItems = itemsForFamily(family);
  if (familyItems.length < 2) {
    res.status(404).json({ error: "not_enough_items" });
    return;
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
