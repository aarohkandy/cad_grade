import { randomUUID } from "node:crypto";
import type { ArenaFamily, ArenaItem, BattleGroup } from "../shared/types";
import { initialEloForItem } from "./elo.js";

const MAX_SCORED_PAIRS = 5000;
const EXPLORATION_RATE = 0.08;

export interface ItemStatLike {
  item_id: string;
  elo?: number | null;
  battle_count?: number | null;
}

export interface PairStatLike {
  pair_key: string;
  family?: BattleGroup | null;
  item_a_family?: ArenaFamily | null;
  item_b_family?: ArenaFamily | null;
  battle_count?: number | null;
}

export function pairKey(leftItemId: string, rightItemId: string): string {
  return [leftItemId, rightItemId].sort().join("__");
}

export function battleId(leftItemId: string, rightItemId: string): string {
  return `battle_${pairKey(leftItemId, rightItemId)}_${randomUUID()}`;
}

export function pairGroup(left: ArenaItem, right: ArenaItem): BattleGroup {
  return left.family === right.family ? left.family : "mixed";
}

export function familyComboKey(leftFamily: ArenaFamily, rightFamily: ArenaFamily): string {
  return [leftFamily, rightFamily].sort().join("__");
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

function eloValue(stat: ItemStatLike | undefined, item: ArenaItem): number {
  const value = Number(stat?.elo);
  return Number.isFinite(value) ? value : initialEloForItem(item);
}

function pairBattles(pairStats: Map<string, PairStatLike> | undefined, leftId: string, rightId: string): number {
  const value = Number(pairStats?.get(pairKey(leftId, rightId))?.battle_count);
  return Number.isFinite(value) ? value : 0;
}

function sessionItemCounts(votedPairKeys: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of votedPairKeys) {
    const [leftId, rightId] = key.split("__");
    if (!leftId || !rightId) continue;
    counts.set(leftId, (counts.get(leftId) || 0) + 1);
    counts.set(rightId, (counts.get(rightId) || 0) + 1);
  }
  return counts;
}

function sessionFamilyComboCounts(votedPairKeys: Set<string>, items: ArenaItem[]): Map<string, number> {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const counts = new Map<string, number>();
  for (const key of votedPairKeys) {
    const [leftId, rightId] = key.split("__");
    const left = leftId ? itemsById.get(leftId) : undefined;
    const right = rightId ? itemsById.get(rightId) : undefined;
    if (!left || !right) continue;
    const combo = familyComboKey(left.family, right.family);
    counts.set(combo, (counts.get(combo) || 0) + 1);
  }
  return counts;
}

function statFamilyCombo(stat: PairStatLike): string | null {
  if (stat.item_a_family && stat.item_b_family) {
    return familyComboKey(stat.item_a_family, stat.item_b_family);
  }
  return stat.family && stat.family !== "mixed" ? familyComboKey(stat.family, stat.family) : null;
}

function historicalFamilyComboCounts(pairStats: Map<string, PairStatLike> | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stat of pairStats?.values() || []) {
    const combo = statFamilyCombo(stat);
    const battles = Number(stat.battle_count);
    if (!combo || !Number.isFinite(battles)) continue;
    counts.set(combo, (counts.get(combo) || 0) + battles);
  }
  return counts;
}

function maybeSamplePairs(
  pairs: Array<[ArenaItem, ArenaItem]>,
  random: () => number,
  maxPairs = MAX_SCORED_PAIRS,
): Array<[ArenaItem, ArenaItem]> {
  if (pairs.length <= maxPairs) return pairs;
  const sample: Array<[ArenaItem, ArenaItem]> = [];
  const seen = new Set<number>();
  while (sample.length < maxPairs && seen.size < pairs.length) {
    const index = Math.min(pairs.length - 1, Math.floor(random() * pairs.length));
    if (seen.has(index)) continue;
    seen.add(index);
    sample.push(pairs[index]);
  }
  return sample;
}

function scorePair(input: {
  pair: [ArenaItem, ArenaItem];
  votedItemCounts: Map<string, number>;
  itemStats?: Map<string, ItemStatLike>;
  pairStats?: Map<string, PairStatLike>;
  random: () => number;
}): number {
  const [left, right] = input.pair;
  const leftStat = input.itemStats?.get(left.id);
  const rightStat = input.itemStats?.get(right.id);
  const leftBattles = battleCount(leftStat);
  const rightBattles = battleCount(rightStat);
  const leftSessionBattles = input.votedItemCounts.get(left.id) || 0;
  const rightSessionBattles = input.votedItemCounts.get(right.id) || 0;
  const repeatedPairPenalty = pairBattles(input.pairStats, left.id, right.id) * 420;
  const exposurePenalty = Math.max(leftBattles, rightBattles) * 24 + Math.min(leftBattles, rightBattles) * 12;
  const sessionExposurePenalty = Math.max(leftSessionBattles, rightSessionBattles) * 180 + Math.min(leftSessionBattles, rightSessionBattles) * 90;
  const hasRankingSignal = leftBattles >= 4 && rightBattles >= 4;
  const eloGapPenalty = Math.abs(eloValue(leftStat, left) - eloValue(rightStat, right)) / (hasRankingSignal ? 16 : 80);
  return repeatedPairPenalty + exposurePenalty + sessionExposurePenalty + eloGapPenalty + input.random();
}

function selectFromScoredPairs(
  scored: Array<{ pair: [ArenaItem, ArenaItem]; score: number }>,
  random: () => number,
): [ArenaItem, ArenaItem] {
  scored.sort((left, right) => left.score - right.score);
  const poolSize = Math.min(scored.length, Math.max(1, Math.min(24, Math.ceil(scored.length * 0.08))));
  const selected = scored[Math.min(poolSize - 1, Math.floor(random() * poolSize))].pair;
  return random() > 0.5 ? selected : [selected[1], selected[0]];
}

function globalCandidateBucket(input: {
  items: ArenaItem[];
  candidates: Array<[ArenaItem, ArenaItem]>;
  votedPairKeys: Set<string>;
  pairStats?: Map<string, PairStatLike>;
  random: () => number;
}): Array<[ArenaItem, ArenaItem]> {
  const buckets = new Map<string, Array<[ArenaItem, ArenaItem]>>();
  for (const pair of input.candidates) {
    const [left, right] = pair;
    const combo = familyComboKey(left.family, right.family);
    const bucket = buckets.get(combo) || [];
    bucket.push(pair);
    buckets.set(combo, bucket);
  }

  if (buckets.size <= 1) return input.candidates;

  const historicalCounts = historicalFamilyComboCounts(input.pairStats);
  const sessionCounts = sessionFamilyComboCounts(input.votedPairKeys, input.items);
  const rawScored = [...buckets.entries()].map(([combo, pairs]) => {
    const knownPairs = pairs.filter(([left, right]) => pairBattles(input.pairStats, left.id, right.id) > 0).length;
    const coverageRatio = knownPairs / pairs.length;
    const sessionCount = sessionCounts.get(combo) || 0;
    const score = (historicalCounts.get(combo) || 0) * 1000 + coverageRatio * 30 + input.random() * 50;
    return { combo, pairs, score, sessionCount };
  });
  const lowestSessionCount = Math.min(...rawScored.map((row) => row.sessionCount));
  const scored = rawScored.filter((row) => row.sessionCount === lowestSessionCount);

  scored.sort((left, right) => left.score - right.score);
  return scored[0].pairs;
}

function familyBattleCount(
  family: ArenaFamily,
  familyItems: ArenaItem[],
  itemStats: Map<string, ItemStatLike> | undefined,
  pairStats: Map<string, PairStatLike> | undefined,
): number {
  let pairTotal = 0;
  let pairRows = 0;
  for (const stat of pairStats?.values() || []) {
    if (stat.family !== family) continue;
    const battles = Number(stat.battle_count);
    if (!Number.isFinite(battles)) continue;
    pairTotal += battles;
    pairRows += 1;
  }
  if (pairRows > 0) return pairTotal;

  const itemBattleTotal = familyItems.reduce((sum, item) => sum + battleCount(itemStats?.get(item.id)), 0);
  return itemBattleTotal / 2;
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
  const familyRows = input.families.map((family) => {
    const familyItems = input.items.filter((item) => item.family === family);
    const pairs = allPairs(familyItems);
    return {
      family,
      familyItems,
      pairs,
      familyBattles: familyBattleCount(family, familyItems, input.itemStats, input.pairStats),
    };
  });

  const scored = familyRows
    .map(({ family, familyItems, pairs, familyBattles }) => {
      if (!pairs.length) return { family, score: Number.POSITIVE_INFINITY };

      const availablePairCount = pairs.filter(([left, right]) => !votedPairKeys.has(pairKey(left.id, right.id))).length;
      const itemBattleAverage =
        familyItems.reduce((sum, item) => sum + battleCount(input.itemStats?.get(item.id)), 0) / familyItems.length;
      const coveredPairs = pairs.filter(([left, right]) => pairBattles(input.pairStats, left.id, right.id) > 0).length;
      const pairCoverageRatio = coveredPairs / pairs.length;

      const exhaustedForSessionPenalty = availablePairCount > 0 ? 0 : 10_000;
      const score = exhaustedForSessionPenalty + familyBattles * 1000 + itemBattleAverage * 10 + pairCoverageRatio * 35 + random();
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
  const candidates = maybeSamplePairs(unvoted.length ? unvoted : pairs, random);
  const familyCount = new Set(input.items.map((item) => item.family)).size;
  const bucket = familyCount > 1
    ? globalCandidateBucket({
        items: input.items,
        candidates,
        votedPairKeys,
        pairStats: input.pairStats,
        random,
      })
    : candidates;

  if (random() > 1 - EXPLORATION_RATE) {
    const selected = bucket[Math.min(bucket.length - 1, Math.floor(random() * bucket.length))];
    return random() > 0.5 ? selected : [selected[1], selected[0]];
  }

  const votedItemCounts = sessionItemCounts(votedPairKeys);
  const scored = bucket.map((pair) => ({
    pair,
    score: scorePair({
      pair,
      votedItemCounts,
      itemStats: input.itemStats,
      pairStats: input.pairStats,
      random,
    }),
  }));

  return selectFromScoredPairs(scored, random);
}
