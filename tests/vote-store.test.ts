import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { initialEloForItem } from "../src/server/elo";
import {
  applyVoteToSummary,
  emptySummary,
  sessionPairPath,
  summaryFromVotes,
  votePath,
  type StoredVoteRecord,
} from "../src/server/voteStore";
import type { ArenaFamily, ArenaItem } from "../src/shared/types";

function item(id: string, family: ArenaFamily = "wall_planter"): ArenaItem {
  return {
    id,
    family,
    familyLabel: family === "wall_planter" ? "Wall planter" : family === "wall_hook" ? "Wall hook" : "Snowman",
    active: true,
    title: id,
    seedId: id,
    specificityLevel: 1,
    repetition: 0,
    experimentId: "exp",
    modelName: "model",
    provider: "provider",
    latencyMs: 100,
    validation: null,
    tags: [],
    stlUrl: "/model.stl",
    previewUrl: "/preview.png",
    sourceHash: id,
  };
}

function vote(overrides: Partial<StoredVoteRecord> = {}): StoredVoteRecord {
  return {
    id: "vote-1",
    created_at: "2026-06-12T14:00:00.000Z",
    dataset_id: "dataset",
    battle_id: "battle",
    family: "wall_planter",
    left_item_id: "a",
    right_item_id: "b",
    winner_item_id: "a",
    loser_item_id: "b",
    vote_result: "winner",
    session_id: "session-1234567890",
    started_at: "2026-06-12T13:59:55.000Z",
    models_loaded_at: "2026-06-12T13:59:56.000Z",
    voted_at: "2026-06-12T14:00:00.000Z",
    elapsed_ms: 5000,
    load_ms: 1000,
    hold_duration_ms: 900,
    hold_target_ms: 900,
    hold_passed: true,
    duplicate_pair: false,
    too_fast: false,
    accepted_for_scoring: true,
    quality_flags: [],
    ip_hash: "ip",
    user_agent_hash: "ua",
    raw_payload: {
      battle_id: "battle",
      left_item_id: "a",
      right_item_id: "b",
      winner_item_id: "a",
      loser_item_id: "b",
      vote_result: "winner",
    },
    storage: {
      mode: "local",
      path: "votes/v1/2026-06-12/file.json",
    },
    ...overrides,
  };
}

describe("vote store helpers", () => {
  it("builds stable private object paths", () => {
    expect(votePath("2026-06-12T14:00:00.123Z", "abc")).toBe("votes/v1/2026-06-12/2026-06-12T14-00-00-123Z_abc.json");
    expect(sessionPairPath("session-hash", "wall_planter", "b", "a")).toBe(
      "session-pairs/v1/session-hash/wall_planter/a__b.json",
    );
  });

  it("updates accepted vote stats without exposing raw identifiers", () => {
    const winner = item("a");
    const loser = item("b");
    const summary = applyVoteToSummary(
      emptySummary("dataset", ["wall_planter", "wall_hook"]),
      vote(),
      winner,
      loser,
      winner,
      loser,
    );
    expect(summary.totalVotes).toBe(1);
    expect(summary.acceptedVotes).toBe(1);
    expect(summary.itemStats.a.wins).toBe(1);
    expect(summary.itemStats.b.losses).toBe(1);
    expect(summary.pairStats.a__b.item_a_wins).toBe(1);
  });

  it("dampens repeated Elo changes as a pair builds history", () => {
    const winner = item("a");
    const loser = item("b");
    const baseWinnerElo = initialEloForItem(winner);
    const first = applyVoteToSummary(
      emptySummary("dataset", ["wall_planter", "wall_hook"]),
      vote(),
      winner,
      loser,
      winner,
      loser,
    );
    const second = applyVoteToSummary(
      first,
      vote({ id: "vote-2", created_at: "2026-06-12T14:01:00.000Z" }),
      winner,
      loser,
      winner,
      loser,
    );

    const firstGain = first.itemStats.a.elo - baseWinnerElo;
    const secondGain = second.itemStats.a.elo - first.itemStats.a.elo;
    expect(firstGain).toBeGreaterThan(0);
    expect(secondGain).toBeGreaterThan(0);
    expect(secondGain).toBeLessThan(firstGain);
  });

  it("counts accepted draw votes without moving Elo", () => {
    const left = item("a");
    const right = item("b");
    const summary = applyVoteToSummary(
      emptySummary("dataset", ["wall_planter", "wall_hook"]),
      vote({
        winner_item_id: null,
        loser_item_id: null,
        vote_result: "draw",
        raw_payload: {
          battle_id: "battle",
          left_item_id: "a",
          right_item_id: "b",
          winner_item_id: null,
          loser_item_id: null,
          vote_result: "draw",
        },
      }),
      left,
      right,
      null,
      null,
    );

    expect(summary.acceptedVotes).toBe(1);
    expect(summary.itemStats.a.draws).toBe(1);
    expect(summary.itemStats.b.draws).toBe(1);
    expect(summary.itemStats.a.elo).toBe(initialEloForItem(left));
    expect(summary.itemStats.b.elo).toBe(initialEloForItem(right));
    expect(summary.pairStats.a__b.draw_count).toBe(1);
  });

  it("scores cross-family votes globally and records mixed pair metadata", () => {
    const left = item("a", "wall_planter");
    const right = item("h", "wall_hook");
    const summary = applyVoteToSummary(
      emptySummary("dataset", ["wall_planter", "wall_hook", "snowman"]),
      vote({
        family: "mixed",
        right_item_id: "h",
        winner_item_id: "h",
        loser_item_id: "a",
        raw_payload: {
          battle_id: "battle",
          left_item_id: "a",
          right_item_id: "h",
          winner_item_id: "h",
          loser_item_id: "a",
          vote_result: "winner",
        },
      }),
      left,
      right,
      right,
      left,
    );

    expect(summary.mixedVotes).toBe(1);
    expect(summary.mixedAcceptedVotes).toBe(1);
    expect(summary.families.wall_planter.acceptedVotes).toBe(1);
    expect(summary.families.wall_hook.acceptedVotes).toBe(1);
    expect(summary.itemStats.h.wins).toBe(1);
    expect(summary.itemStats.a.losses).toBe(1);
    expect(summary.itemStats.h.elo).toBeGreaterThan(initialEloForItem(right));
    expect(summary.itemStats.a.elo).toBeLessThan(initialEloForItem(left));
    expect(summary.pairStats.a__h).toMatchObject({
      family: "mixed",
      item_a_family: "wall_planter",
      item_b_family: "wall_hook",
      item_b_wins: 1,
    });
  });

  it("can derive a summary from exported raw votes", () => {
    const lookup = (id: string) => (id === "a" || id === "b" ? item(id) : undefined);
    const summary = summaryFromVotes("dataset", ["wall_planter", "wall_hook"], [vote()], lookup);
    expect(summary.families.wall_planter.acceptedVotes).toBe(1);
  });

  it("leaves the summary it was handed untouched", () => {
    const winner = item("a");
    const loser = item("b");
    const before = emptySummary("dataset", ["wall_planter"]);
    const unchanged = JSON.stringify(before);

    applyVoteToSummary(before, vote(), winner, loser, winner, loser);

    expect(JSON.stringify(before)).toBe(unchanged);
  });
});

const FIXTURE_FAMILIES: ArenaFamily[] = ["wall_planter", "wall_hook", "snowman"];

const FIXTURE_ITEMS = [
  ...["p0", "p1", "p2", "p3", "p4"].map((id) => item(id, "wall_planter")),
  ...["h0", "h1", "h2"].map((id) => item(id, "wall_hook")),
  ...["s0", "s1"].map((id) => item(id, "snowman")),
];

function fixtureLookup(id: string): ArenaItem | undefined {
  return FIXTURE_ITEMS.find((candidate) => candidate.id === id);
}

// Four hundred votes over nine items, mixing draws, cross-family pairs and two kinds of
// vote the scoring rules throw out, so the summary this builds exercises every branch of
// the fold rather than just the winner path.
function fixtureVotes(): StoredVoteRecord[] {
  const planters = FIXTURE_ITEMS.filter((entry) => entry.family === "wall_planter");
  const others = FIXTURE_ITEMS.filter((entry) => entry.family !== "wall_planter");

  return Array.from({ length: 400 }, (_unused, index) => {
    const left = planters[index % planters.length];
    const right = index % 5 === 0 ? others[index % others.length] : planters[(index + 2) % planters.length];
    const draw = index % 7 === 0;
    const started = new Date(Date.UTC(2026, 5, 12, 0, 0, 0) + index * 30_000);
    const voted = new Date(started.getTime() + (index % 11 === 0 ? 400 : 6000));

    return vote({
      id: `fixture-${index}`,
      created_at: voted.toISOString(),
      family: left.family === right.family ? left.family : "mixed",
      left_item_id: left.id,
      right_item_id: right.id,
      winner_item_id: draw ? null : index % 2 === 0 ? left.id : right.id,
      loser_item_id: draw ? null : index % 2 === 0 ? right.id : left.id,
      vote_result: draw ? "draw" : "winner",
      session_id: index % 13 === 0 ? "short" : `session-${index}-1234567890`,
      started_at: started.toISOString(),
      models_loaded_at: new Date(started.getTime() + 1200).toISOString(),
      voted_at: voted.toISOString(),
      elapsed_ms: voted.getTime() - started.getTime(),
      load_ms: 1200,
      hold_duration_ms: null,
      hold_target_ms: null,
      hold_passed: false,
      too_fast: index % 11 === 0,
      quality_flags: [
        ...(index % 11 === 0 ? ["too_fast", "hold_required"] : []),
        ...(index % 13 === 0 ? ["weak_session"] : []),
      ],
      accepted_for_scoring: index % 11 !== 0 && index % 13 !== 0,
    });
  });
}

// Captured from the clone-per-vote implementation before the fold moved in place. The
// arena's published rankings come out of this function, so a change here that shifts a
// single digit is a change to the numbers on the site, not a refactor.
const FIXTURE_SUMMARY_SHA256 = "291aa5adb0dbcd018be42985f6190f7c550327ae376784adda733a3d1689119c";

describe("deriving a summary from a full export", () => {
  it("produces the same bytes it produced before the fold moved in place", () => {
    const summary = summaryFromVotes("dataset", FIXTURE_FAMILIES, fixtureVotes(), fixtureLookup);

    // A digest alone would still pass over a fixture that had quietly gone degenerate.
    expect(summary.totalVotes).toBe(400);
    expect(summary.acceptedVotes).toBe(335);
    expect(summary.mixedVotes).toBe(80);
    expect(summary.qualityFlagCounts).toEqual({ too_fast: 37, hold_required: 37, weak_session: 31 });
    expect(createHash("sha256").update(JSON.stringify(summary)).digest("hex")).toBe(FIXTURE_SUMMARY_SHA256);
  });

  it("agrees with applying the same votes one immutable step at a time", () => {
    const votes = fixtureVotes();
    const stepByStep = [...votes]
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .reduce(
        (summary, record) => {
          const left = fixtureLookup(record.left_item_id);
          const right = fixtureLookup(record.right_item_id);
          const winner = record.winner_item_id ? fixtureLookup(record.winner_item_id) || null : null;
          const loser = record.loser_item_id ? fixtureLookup(record.loser_item_id) || null : null;
          return left && right ? applyVoteToSummary(summary, record, left, right, winner, loser) : summary;
        },
        emptySummary("dataset", FIXTURE_FAMILIES),
      );

    const folded = summaryFromVotes("dataset", FIXTURE_FAMILIES, votes, fixtureLookup);

    expect(JSON.stringify(folded)).toBe(JSON.stringify(stepByStep));
  });

  // /api/export runs this on up to 10,000 votes inside a function with a ten-second
  // ceiling, so the clone count has to stay flat as the store grows.
  it("does not clone the summary once per vote", () => {
    const clone = vi.spyOn(globalThis, "structuredClone");

    try {
      summaryFromVotes("dataset", FIXTURE_FAMILIES, fixtureVotes(), fixtureLookup);
      expect(clone.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      clone.mockRestore();
    }
  });
});
