import { randomUUID } from "node:crypto";
import type { ArenaItem } from "../shared/types";

export interface ItemStatLike {
  item_id: string;
  elo?: number | null;
  battle_count?: number | null;
}

export interface PairStatLike {
  pair_key: string;
  battle_count?: number | null;
}

export function pairKey(leftItemId: string, rightItemId: string): string {
  return [leftItemId, rightItemId].sort().join("__");
}

export function battleId(leftItemId: string, rightItemId: string): string {
  return `battle_${pairKey(leftItemId, rightItemId)}_${randomUUID()}`;
}

export function allPairs(items: ArenaItem[]): Array<[ArenaItem, ArenaItem]> {
  const pairs: Array<[ArenaItem, ArenaItem]> = [];
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      pairs.push([items[leftIndex], items[rightIndex]]);
    }
  }
  return pairs;
}

export function selectBattlePair(input: {
  items: ArenaItem[];
  votedPairKeys?: Set<string>;
  itemStats?: Map<string, ItemStatLike>;
  pairStats?: Map<string, PairStatLike>;
  random?: () => number;
}): [ArenaItem, ArenaItem] {
  const random = input.random ?? Math.random;
  const pairs = allPairs(input.items);
  if (pairs.length === 0) throw new Error("At least two active items are required");

  const votedPairKeys = input.votedPairKeys ?? new Set<string>();
  const unvoted = pairs.filter(([left, right]) => !votedPairKeys.has(pairKey(left.id, right.id)));
  const candidates = unvoted.length ? unvoted : pairs;

  const scored = candidates.map((pair) => {
    const [left, right] = pair;
    const leftStat = input.itemStats?.get(left.id);
    const rightStat = input.itemStats?.get(right.id);
    const pairStat = input.pairStats?.get(pairKey(left.id, right.id));
    const leftElo = Number(leftStat?.elo ?? 1200);
    const rightElo = Number(rightStat?.elo ?? 1200);
    const pairBattles = Number(pairStat?.battle_count ?? 0);
    const itemBattles = Number(leftStat?.battle_count ?? 0) + Number(rightStat?.battle_count ?? 0);
    const score = pairBattles * 1000 + Math.abs(leftElo - rightElo) / 12 + itemBattles / 80 + random();
    return { pair, score };
  });

  scored.sort((left, right) => left.score - right.score);
  const selected = scored[0].pair;
  return random() > 0.5 ? selected : [selected[1], selected[0]];
}
