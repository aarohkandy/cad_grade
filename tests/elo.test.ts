import { describe, expect, it } from "vitest";
import { agreementPercent, expectedScore, updateElo } from "../src/server/elo";

describe("elo", () => {
  it("updates winner and loser ratings", () => {
    const updated = updateElo({ elo: 1200 }, { elo: 1200 });
    expect(updated.winnerElo).toBeGreaterThan(1200);
    expect(updated.loserElo).toBeLessThan(1200);
    expect(updated.expectedWinner).toBeCloseTo(0.5);
  });

  it("computes expected score from rating gaps", () => {
    expect(expectedScore(1400, 1200)).toBeGreaterThan(0.7);
    expect(expectedScore(1200, 1400)).toBeLessThan(0.3);
  });

  it("smooths agreement for sparse pairs", () => {
    expect(agreementPercent({ winnerWins: 0, battleCount: 0, winnerElo: 1200, loserElo: 1200 })).toBe(50);
    expect(agreementPercent({ winnerWins: 1, battleCount: 1, winnerElo: 1300, loserElo: 1100 })).toBeGreaterThan(50);
  });
});
