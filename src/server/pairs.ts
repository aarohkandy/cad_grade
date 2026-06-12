import { randomUUID } from "node:crypto";
import type { ArenaFamily, ArenaItem } from "../shared/types";

export interface ItemStatLike {
  item_id: string;
  elo?: number | null;
  battle_count?: number | null;
}

export interface PairStatLike {
  pair_key: string;
  family?: ArenaFamily | null;
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

function battleCount(stat: ItemStatLike | undefined): number {
  const value = Number(stat?.battle_count);
  return Number.isFinite(value) ? value : 0;
}

function eloValue(stat: ItemStatLike | undefined): number {
  const value = Number(stat?.elo);
  return Number.isFinite(value) ? value : 1200;
}

function pairBattles(pairStats: Map<string, PairStatLike> | undefined, leftId: string, rightId: string): number {
  const value = Number(pairStats?.get(pairKey(leftId, rightId))?.battle_count);
  return Number.isFinite(value) ? value : 0;
}

export function selectBattleFamily(input: {
  items: ArenaItem[];
  families: ArenaFamily[];
  votedPairKeys?: Set<string>;
  itemStats?: Map<string, ItemStatLike>;
  pairStats?: Map<string, PairStatLike>;
  random?: () => number;
}): ArenaFamily {
  const random = input.random ?? Math.random;
  const votedPairKeys = input.votedPairKeys ?? new Set<string>();
  const scored = input.families
    .map((family) => {
      const familyItems = input.items.filter((item) => item.family === family);
      const pairs = allPairs(familyItems);
      if (!pairs.length) return { family, score: Number.POSITIVE_INFINITY };

      const availablePairCount = pairs.filter(([left, right]) => !votedPairKeys.has(pairKey(left.id, right.id))).length;
      const itemBattleAverage =
        familyItems.reduce((sum, item) => sum + battleCount(input.itemStats?.get(item.id)), 0) / familyItems.length;
      const coveredPairs = pairs.filter(([left, right]) => pairBattles(input.pairStats, left.id, right.id) > 0).length;
      const pairCoverageRatio = coveredPairs / pairs.length;

      const exhaustedForSessionPenalty = availablePairCount > 0 ? 0 : 10_000;
      const score = exhaustedForSessionPenalty + itemBattleAverage * 100 + pairCoverageRatio * 35 + random();
      return { family, score };
    })
    .sort((left, right) => left.score - right.score);

  const selected = scored[0];
  if (!selected || !Number.isFinite(selected.score)) {
    throw new Error("At least one family with two active items is required");
  }
  return selected.family;
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
    const leftBattles = battleCount(leftStat);
    const rightBattles = battleCount(rightStat);
    const repeatedPairPenalty = pairBattles(input.pairStats, left.id, right.id) * 420;
    const exposurePenalty = Math.max(leftBattles, rightBattles) * 24 + Math.min(leftBattles, rightBattles) * 12;
    const hasRankingSignal = leftBattles >= 4 && rightBattles >= 4;
    const eloGapPenalty = Math.abs(eloValue(leftStat) - eloValue(rightStat)) / (hasRankingSignal ? 16 : 80);
    const score = repeatedPairPenalty + exposurePenalty + eloGapPenalty + random();
    return { pair, score };
  });

  scored.sort((left, right) => left.score - right.score);
  const selected = scored[0].pair;
  return random() > 0.5 ? selected : [selected[1], selected[0]];
}
