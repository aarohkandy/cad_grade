import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUMMARY_PATH,
  updateVoteSummary,
  votePath,
  writeVoteRecord,
  type StoredVoteRecord,
} from "../src/server/voteStore";
import type { ArenaFamily, ArenaItem } from "../src/shared/types";

function item(id: string, family: ArenaFamily = "wall_planter"): ArenaItem {
  return {
    id,
    family,
    familyLabel: "Wall planter",
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

function vote(index: number): StoredVoteRecord {
  const createdAt = new Date(Date.UTC(2026, 5, 12, 14, 0, index)).toISOString();
  return {
    id: `vote-${index}`,
    created_at: createdAt,
    dataset_id: "dataset",
    battle_id: `battle-${index}`,
    family: "wall_planter",
    left_item_id: "a",
    right_item_id: "b",
    winner_item_id: "a",
    loser_item_id: "b",
    vote_result: "winner",
    session_id: `session-${index}-1234567890`,
    started_at: createdAt,
    models_loaded_at: createdAt,
    voted_at: createdAt,
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
      battle_id: `battle-${index}`,
      left_item_id: "a",
      right_item_id: "b",
      winner_item_id: "a",
      loser_item_id: "b",
      vote_result: "winner",
    },
    storage: { mode: "local", path: votePath(createdAt, `vote-${index}`) },
  };
}

describe("local vote storage", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cad-local-store-"));
    process.env.LOCAL_VOTE_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.LOCAL_VOTE_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // A parallel Playwright run really did leave one writer's tail after another's document
  // here, which every later read of the summary then threw on.
  it("leaves a parsable summary after concurrent updates", async () => {
    const left = item("a");
    const right = item("b");
    const writes = [];
    for (let index = 0; index < 40; index += 1) {
      const record = vote(index);
      // Writing the record first is what a request does, and it staggers the summary
      // updates the way concurrent requests stagger them.
      await writeVoteRecord(record);
      writes.push(updateVoteSummary("dataset", ["wall_planter"], record, left, right, left, right));
    }
    await Promise.all(writes);

    const body = await readFile(join(dir, SUMMARY_PATH), "utf8");
    const summary = JSON.parse(body);
    expect(summary.datasetId).toBe("dataset");
    expect(summary.totalVotes).toBeGreaterThan(0);
  });
});
