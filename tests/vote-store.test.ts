import { describe, expect, it } from "vitest";
import { applyVoteToSummary, emptySummary, sessionPairPath, summaryFromVotes, votePath, type StoredVoteRecord } from "../src/server/voteStore";
import type { ArenaItem } from "../src/shared/types";

function item(id: string): ArenaItem {
  return {
    id,
    family: "wall_planter",
    familyLabel: "Wall planter",
    active: true,
    title: id,
    seedId: id,
    prompt: "prompt",
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
    session_id: "session",
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
    expect(votePath("2026-06-12T14:00:00.123Z", "abc")).toBe(
      "votes/v1/2026-06-12/2026-06-12T14-00-00-123Z_abc.json",
    );
    expect(sessionPairPath("session-hash", "wall_planter", "b", "a")).toBe(
      "session-pairs/v1/session-hash/wall_planter/a__b.json",
    );
  });

  it("updates accepted vote stats without exposing raw identifiers", () => {
    const winner = item("a");
    const loser = item("b");
    const summary = applyVoteToSummary(emptySummary("dataset", ["wall_planter", "wall_hook"]), vote(), winner, loser);
    expect(summary.totalVotes).toBe(1);
    expect(summary.acceptedVotes).toBe(1);
    expect(summary.itemStats.a.wins).toBe(1);
    expect(summary.itemStats.b.losses).toBe(1);
    expect(summary.pairStats.a__b.item_a_wins).toBe(1);
  });

  it("can derive a summary from exported raw votes", () => {
    const lookup = (id: string) => (id === "a" || id === "b" ? item(id) : undefined);
    const summary = summaryFromVotes("dataset", ["wall_planter", "wall_hook"], [vote()], lookup);
    expect(summary.families.wall_planter.acceptedVotes).toBe(1);
  });
});
