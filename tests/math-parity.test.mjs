import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeVotes,
  eloVoteWeight as analysisVoteWeight,
  initialEloForItem as analysisInitialElo,
  updateElo as analysisUpdateElo,
} from "../scripts/analysis-core.mjs";
import { eloVoteWeight, initialEloForItem, updateElo } from "../src/server/elo";
import { acceptedForCurrentScoring } from "../src/server/quality";

// scripts/analysis-core.mjs keeps its own copy of the rating math and the quality decision
// so the offline analysis runs as plain node with no build step. The arena's stored ratings
// came out of src/server/elo.ts and its accept/reject calls came out of
// src/server/quality.ts, so those sides are the source of truth: any disagreement below
// means exports/analysis/ is publishing numbers the arena never computed.

const dataset = JSON.parse(readFileSync(new URL("../src/data/items.generated.json", import.meta.url), "utf8"));

// The stored summary calls the field battle_count; analysis-core's in-memory item rows call
// it battles. Same number, so the sweep feeds each side the name it expects.
const BATTLE_COUNTS = [0, 1, 2, 3, 5, 8, 10, 13, 21, 50, 100, 500];
const RATING_PAIRS = [
  [1200, 1200],
  [1200, 1199.5],
  [1213.75, 1186.25],
  [1290, 1110],
  [1110, 1290],
  [1400, 1200],
  [1200, 1400],
  [1000, 1600],
];

function analysisWeight(winnerBattles, loserBattles) {
  return analysisVoteWeight({ battles: winnerBattles }, { battles: loserBattles });
}

function arenaWeight(winnerBattles, loserBattles) {
  return eloVoteWeight({ battle_count: winnerBattles }, { battle_count: loserBattles });
}

describe("rating math parity between the arena and the offline analysis", () => {
  it("seeds every committed item at the same starting rating", () => {
    const mismatches = dataset.items
      .map((item) => ({ id: item.id, arena: initialEloForItem(item), analysis: analysisInitialElo(item) }))
      .filter((row) => row.arena !== row.analysis);

    expect(dataset.items).toHaveLength(94);
    expect(mismatches).toEqual([]);
  });

  it("decays the vote weight on the same schedule", () => {
    const mismatches = [];
    for (const left of BATTLE_COUNTS) {
      for (const right of BATTLE_COUNTS) {
        const arena = arenaWeight(left, right);
        const analysis = analysisWeight(left, right);
        if (arena !== analysis) mismatches.push({ left, right, arena, analysis });
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("moves both ratings by the same amount at every gap and weight", () => {
    const mismatches = [];
    for (const [winnerElo, loserElo] of RATING_PAIRS) {
      for (const battles of BATTLE_COUNTS) {
        const arena = updateElo(
          { elo: winnerElo, battle_count: battles },
          { elo: loserElo, battle_count: battles },
          { weight: arenaWeight(battles, battles) },
        );
        const analysis = analysisUpdateElo(winnerElo, loserElo, analysisWeight(battles, battles));
        if (arena.winnerElo !== analysis.winner || arena.loserElo !== analysis.loser) {
          mismatches.push({ winnerElo, loserElo, battles, arena, analysis });
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  // A single-update check is not enough: an unrounded weight is off by well under a
  // thousandth, so it only shows up once the ratings it feeds are themselves rounded.
  it("stays in lockstep vote after vote, not just on the first update", () => {
    const arena = { a: { elo: 1200, battle_count: 0 }, b: { elo: 1200, battle_count: 0 } };
    const analysis = { a: { elo: 1200, battles: 0 }, b: { elo: 1200, battles: 0 } };
    const divergedAt = [];

    for (let index = 0; index < 400; index += 1) {
      // A lopsided but not one-sided run, so the gap grows and expectedScore keeps moving.
      const [winner, loser] = index % 3 === 0 ? ["b", "a"] : ["a", "b"];

      const arenaNext = updateElo(arena[winner], arena[loser], {
        weight: eloVoteWeight(arena[winner], arena[loser]),
      });
      arena[winner] = { elo: arenaNext.winnerElo, battle_count: arena[winner].battle_count + 1 };
      arena[loser] = { elo: arenaNext.loserElo, battle_count: arena[loser].battle_count + 1 };

      const analysisNext = analysisUpdateElo(
        analysis[winner].elo,
        analysis[loser].elo,
        analysisVoteWeight(analysis[winner], analysis[loser]),
      );
      analysis[winner] = { elo: analysisNext.winner, battles: analysis[winner].battles + 1 };
      analysis[loser] = { elo: analysisNext.loser, battles: analysis[loser].battles + 1 };

      if (arena.a.elo !== analysis.a.elo || arena.b.elo !== analysis.b.elo) {
        divergedAt.push({ vote: index + 1, arena: arena.a.elo, analysis: analysis.a.elo });
      }
    }

    // Sliced only to keep the failure output readable; any divergence lands in the slice.
    expect(divergedAt.slice(0, 3)).toEqual([]);
    expect(analysis.a.elo).toBe(arena.a.elo);
    expect(analysis.b.elo).toBe(arena.b.elo);
    // Guard against the run degenerating into a no-op that would agree trivially.
    expect(arena.a.elo).toBeGreaterThan(1220);
  });

  // The three sweeps above pin the functions. This one pins the number that actually
  // reaches exports/analysis/rankings_clean.csv, which is what anybody reads.
  it("publishes the rating the arena's own math produces for the same votes", () => {
    const items = [analysisItem("a"), analysisItem("b")];
    const votes = Array.from({ length: 6 }, (_, index) => analysisVote({ index, winner: index % 4 === 0 ? "b" : "a" }));

    const expected = { a: { elo: initialEloForItem(items[0]) }, b: { elo: initialEloForItem(items[1]) } };
    expected.a.battle_count = 0;
    expected.b.battle_count = 0;
    for (const vote of votes) {
      const winner = vote.winner_item_id;
      const loser = winner === "a" ? "b" : "a";
      const next = updateElo(expected[winner], expected[loser], {
        weight: eloVoteWeight(expected[winner], expected[loser]),
      });
      expected[winner] = { elo: next.winnerElo, battle_count: expected[winner].battle_count + 1 };
      expected[loser] = { elo: next.loserElo, battle_count: expected[loser].battle_count + 1 };
    }

    const analysis = analyzeVotes({
      dataset: { datasetId: "parity", itemCount: 2, families: ["wall_planter"], items },
      votes,
      generatedAtUtc: "2026-06-14T13:00:00.000Z",
    });
    const published = Object.fromEntries(analysis.rankingsClean.map((row) => [row.item_id, row.elo]));

    expect(analysis.totals.cleanVotes).toBe(votes.length);
    expect(published).toEqual({ a: expected.a.elo, b: expected.b.elo });
  });

  // The rating math is only half the copy. The other half decides which votes get rated at
  // all, and a session id is the field a scraper controls — String(Date.now()) is thirteen
  // characters, so a length-only check waves it through while the arena calls it weak.
  it("agrees on which sessions are too weak to score", () => {
    const sessions = [
      "session-human-123456",
      "123456789012",
      "abc",
      "",
      1755500000000,
      12345,
      null,
      undefined,
      { id: "session-human-123456" },
    ];

    const disagreements = sessions
      .map((session_id) => bothVerdicts({ session_id }))
      .filter((row) => row.arena !== row.analysis);

    expect(disagreements).toEqual([]);
    // A sweep where nothing is ever rejected would agree trivially.
    expect(sessions.map((session_id) => bothVerdicts({ session_id }).arena)).toContain(false);
  });

  it("agrees on which votes have no usable timing", () => {
    const timestamps = [
      { started_at: "whenever" },
      { models_loaded_at: "" },
      { voted_at: "2026-13-45T99:00:00.000Z" },
      { started_at: undefined },
      { voted_at: "2026-06-14T12:00:00.000Z" },
    ];

    const disagreements = timestamps.map(bothVerdicts).filter((row) => row.arena !== row.analysis);

    expect(disagreements).toEqual([]);
    expect(timestamps.map((row) => bothVerdicts(row).arena)).toContain(false);
  });
});

// One stored vote through each side: acceptedForCurrentScoring is what the arena's summary
// counts, cleanVotes is what rankings_clean.csv is built from.
function bothVerdicts(overrides) {
  const vote = { ...analysisVote({ index: 0, winner: "a" }), ...overrides };
  const analysis = analyzeVotes({
    dataset: {
      datasetId: "parity",
      itemCount: 2,
      families: ["wall_planter"],
      items: [analysisItem("a"), analysisItem("b")],
    },
    votes: [vote],
    generatedAtUtc: "2026-06-14T13:00:00.000Z",
  });
  return { ...overrides, arena: acceptedForCurrentScoring(vote), analysis: analysis.totals.cleanVotes === 1 };
}

function analysisItem(id) {
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
    validation: { valid: true, confidence: 1, issues: [], attempt_count: 1 },
    tags: [],
    stlUrl: "/model.stl",
    previewUrl: "/preview.png",
    sourceHash: id,
  };
}

function analysisVote({ index, winner }) {
  const second = String(index).padStart(2, "0");
  return {
    id: `parity-${index}`,
    created_at: `2026-06-14T12:00:${second}.000Z`,
    dataset_id: "parity",
    battle_id: "battle",
    family: "wall_planter",
    left_item_id: "a",
    right_item_id: "b",
    winner_item_id: winner,
    loser_item_id: winner === "a" ? "b" : "a",
    vote_result: "winner",
    session_id: "session-human-123456",
    started_at: `2026-06-14T11:59:${second}.000Z`,
    models_loaded_at: `2026-06-14T11:59:${second}.900Z`,
    voted_at: `2026-06-14T12:00:${second}.000Z`,
    elapsed_ms: 5000,
    load_ms: 900,
    hold_duration_ms: null,
    hold_passed: false,
    duplicate_pair: false,
    too_fast: false,
    accepted_for_scoring: true,
    quality_flags: [],
    storage: { mode: "blob", path: `votes/v1/2026-06-14/parity-${index}.json` },
  };
}
