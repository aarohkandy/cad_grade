import { describe, expect, it } from "vitest";
import { agreementPercent, expectedScore, initialEloForItem, updateElo } from "../src/server/elo";
import type { ArenaItem } from "../src/shared/types";

function item(id: string, overrides: Partial<ArenaItem> = {}): ArenaItem {
  return {
    id,
    family: "wall_planter",
    familyLabel: "Wall planter",
    active: true,
    title: id,
    seedId: id,
    specificityLevel: 5,
    repetition: 0,
    experimentId: "exp",
    modelName: "model",
    provider: "provider",
    latencyMs: 60_000,
    validation: { valid: true, confidence: 1, issues: [] },
    tags: [],
    stlUrl: "/model.stl",
    previewUrl: "/preview.png",
    sourceHash: id,
    ...overrides,
  };
}

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

  it("creates deterministic seeded ratings for unrated items", () => {
    const stronger = item("full", { title: "full model", specificityLevel: 10, sourceHash: "aaa" });
    const weaker = item("minimal", { title: "minimal model", specificityLevel: 1, sourceHash: "bbb" });
    expect(initialEloForItem(stronger)).toBe(initialEloForItem(stronger));
    expect(initialEloForItem(stronger)).toBeGreaterThan(initialEloForItem(weaker));
  });
});
