import { describe, expect, it } from "vitest";
import {
  boundedPercent,
  directAgreementProbability,
  eloAgreementProbability,
  eloVoteWeight,
  expectedScore,
  initialEloForItem,
  tieAgreementProbability,
  updateElo,
} from "../src/server/elo";
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

  it("reads rating gaps on the shorter display scale", () => {
    expect(eloAgreementProbability(1200, 1200)).toBeCloseTo(0.5);
    expect(eloAgreementProbability(1260, 1200)).toBeGreaterThan(expectedScore(1260, 1200));
    expect(eloAgreementProbability(1200, 1260)).toBeLessThan(0.5);
  });

  it("treats a tie as likelier the closer two models are rated", () => {
    expect(tieAgreementProbability(1200, 1200)).toBeCloseTo(0.56);
    expect(tieAgreementProbability(1200, 1400)).toBeLessThan(0.25);
    expect(tieAgreementProbability(1200, 1300)).toBe(tieAgreementProbability(1300, 1200));
  });

  it("smooths agreement for sparse pairs", () => {
    expect(directAgreementProbability({ directWins: 0, sampleSize: 0, priorProbability: 0.62 })).toBeCloseTo(0.62);
    expect(directAgreementProbability({ directWins: 5, sampleSize: 5, priorProbability: 0.5 })).toBeCloseTo(9 / 13);
    expect(directAgreementProbability({ directWins: 0, sampleSize: 5, priorProbability: 0.5 })).toBeCloseTo(4 / 13);
  });

  it("never reports a certain or perfectly flat crowd read", () => {
    expect(boundedPercent(0.999)).toBe(96);
    expect(boundedPercent(0.0001)).toBe(4);
    expect(boundedPercent(0.5)).toBe(50);
    expect(boundedPercent(0.502)).toBe(51);
    expect(boundedPercent(0.498)).toBe(49);
  });

  it("creates deterministic seeded ratings for unrated items", () => {
    const stronger = item("full", { title: "full model", specificityLevel: 10, sourceHash: "aaa" });
    const weaker = item("minimal", { title: "minimal model", specificityLevel: 1, sourceHash: "bbb" });
    expect(initialEloForItem(stronger)).toBe(initialEloForItem(stronger));
    expect(initialEloForItem(stronger)).toBeGreaterThan(initialEloForItem(weaker));
  });

  it("shrinks Elo update weight as models build history", () => {
    expect(eloVoteWeight({ battle_count: 0 }, { battle_count: 0 })).toBe(1);
    expect(eloVoteWeight({ battle_count: 40 }, { battle_count: 60 })).toBeLessThan(0.2);
    expect(eloVoteWeight({ battle_count: 400 }, { battle_count: 500 })).toBeGreaterThan(0);
  });
});
