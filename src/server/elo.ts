const DEFAULT_ELO = 1200;
const DEFAULT_K = 28;

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

export function agreementPercent(input: {
  winnerWins: number;
  battleCount: number;
  winnerElo?: number | null;
  loserElo?: number | null;
}): number {
  const battleCount = Math.max(0, input.battleCount || 0);
  const winnerWins = Math.max(0, input.winnerWins || 0);
  const prior = expectedScore(normalizedElo({ elo: input.winnerElo }), normalizedElo({ elo: input.loserElo }));
  const smoothed = (winnerWins + prior * 4) / Math.max(1, battleCount + 4);
  const raw = battleCount >= 5 ? winnerWins / battleCount : smoothed;
  return Math.round(Math.max(0.04, Math.min(0.96, raw)) * 100);
}
