import type { ArenaItem } from "../shared/types";

const DEFAULT_ELO = 1200;
const DEFAULT_K = 28;
const ELO_DECAY_PRIOR_BATTLES = 10;
const ELO_MIN_VOTE_WEIGHT = 0.16;
const AGREEMENT_PRIOR_BATTLES = 8;

export interface EloInput {
  elo?: number | null;
  wins?: number | null;
  losses?: number | null;
  battle_count?: number | null;
}

export interface EloUpdate {
  winnerElo: number;
  loserElo: number;
  expectedWinner: number;
}

export function normalizedElo(value: EloInput | undefined): number {
  const elo = Number(value?.elo);
  return Number.isFinite(elo) ? elo : DEFAULT_ELO;
}

function stableUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function validationAttempt(item: ArenaItem): number | null {
  const value = Number((item.validation as { attempt_count?: unknown } | null)?.attempt_count);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function initialEloForItem(item: ArenaItem): number {
  const confidence = Number(item.validation?.confidence);
  const attempt = validationAttempt(item);
  const issueCount = item.validation?.issues?.length || 0;
  const level = Number(item.specificityLevel);
  const latency = Number(item.latencyMs);
  const title = item.title.toLowerCase();
  const jitter = stableUnit(`${item.id}:${item.sourceHash}`);

  let elo = DEFAULT_ELO;
  elo += item.validation?.valid === false ? -90 : 10;
  if (Number.isFinite(confidence)) elo += (confidence - 0.85) * 36;
  elo -= issueCount * 8;
  if (attempt !== null) elo += Math.max(-18, 8 - (attempt - 1) * 7);
  if (Number.isFinite(level)) elo += (level - 5) * 2.2;
  elo -= Math.min(6, Math.max(0, item.repetition || 0) * 1.5);
  if (Number.isFinite(latency)) elo += Math.max(-9, Math.min(7, (70_000 - latency) / 10_000));
  if (title.includes("full")) elo += 14;
  else if (title.includes("dimensions")) elo += 9;
  else if (title.includes("printable")) elo += 5;
  else if (title.includes("clear")) elo += 2;
  else if (title.includes("minimal")) elo -= 3;
  elo += (jitter - 0.5) * 18;

  return Math.round(elo * 1000) / 1000;
}

export function expectedScore(playerElo: number, opponentElo: number): number {
  return 1 / (1 + 10 ** ((opponentElo - playerElo) / 400));
}

export function updateElo(
  winner: EloInput | undefined,
  loser: EloInput | undefined,
  options: { k?: number; weight?: number } = {},
): EloUpdate {
  const winnerElo = normalizedElo(winner);
  const loserElo = normalizedElo(loser);
  const expectedWinner = expectedScore(winnerElo, loserElo);
  const k = options.k ?? DEFAULT_K;
  const weight = Math.max(0, Math.min(1, options.weight ?? 1));
  const delta = k * weight * (1 - expectedWinner);
  return {
    winnerElo: Math.round((winnerElo + delta) * 1000) / 1000,
    loserElo: Math.round((loserElo - delta) * 1000) / 1000,
    expectedWinner,
  };
}

export function eloVoteWeight(left: EloInput | undefined, right: EloInput | undefined): number {
  const leftBattles = Math.max(0, Number(left?.battle_count) || 0);
  const rightBattles = Math.max(0, Number(right?.battle_count) || 0);
  const averageBattles = (leftBattles + rightBattles) / 2;
  const raw = ELO_DECAY_PRIOR_BATTLES / (ELO_DECAY_PRIOR_BATTLES + averageBattles);
  return Math.round(Math.max(ELO_MIN_VOTE_WEIGHT, Math.min(1, raw)) * 1000) / 1000;
}

export function agreementPercent(input: {
  winnerWins: number;
  battleCount: number;
  winnerElo?: number | null;
  loserElo?: number | null;
}): number {
  const battleCount = Math.max(0, input.battleCount || 0);
  const winnerWins = Math.max(0, input.winnerWins || 0);
  const prior = expectedScore(normalizedElo({ elo: input.winnerElo }), normalizedElo({ elo: input.loserElo }));
  const smoothed = (winnerWins + prior * AGREEMENT_PRIOR_BATTLES) / Math.max(1, battleCount + AGREEMENT_PRIOR_BATTLES);
  return Math.round(Math.max(0.04, Math.min(0.96, smoothed)) * 100);
}
