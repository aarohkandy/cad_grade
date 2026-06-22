import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handler from "../api/export";
import { dataset } from "../src/server/items";
import { updateVoteSummary, type StoredVoteRecord } from "../src/server/voteStore";

function mockResponse() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string | number | string[]>,
    setHeader(key: string, value: string | number | string[]) {
      this.headers[key] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return response;
}

describe("export api", () => {
  it("allows unlisted export pulls", async () => {
    const response = mockResponse();
    await handler({ method: "GET", headers: {}, query: {} } as never, response as never);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ voteCount: expect.any(Number) });
  });

  it("exports derived summary stats when raw vote records are gone", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cad-export-summary-"));
    const previousVoteDir = process.env.LOCAL_VOTE_DIR;
    try {
      process.env.LOCAL_VOTE_DIR = tempDir;
      const [left, right] = dataset.items.filter((item) => item.family === "wall_hook");
      const vote: StoredVoteRecord = {
        id: "summary-only-vote",
        created_at: "2026-06-22T20:00:00.000Z",
        dataset_id: dataset.datasetId,
        battle_id: "battle",
        family: "wall_hook",
        left_item_id: left.id,
        right_item_id: right.id,
        winner_item_id: left.id,
        loser_item_id: right.id,
        vote_result: "winner",
        session_id: "session-summary-only",
        started_at: "2026-06-22T19:59:55.000Z",
        models_loaded_at: "2026-06-22T19:59:56.000Z",
        voted_at: "2026-06-22T20:00:00.000Z",
        elapsed_ms: 5000,
        load_ms: 1000,
        hold_duration_ms: null,
        hold_target_ms: null,
        hold_passed: false,
        duplicate_pair: false,
        too_fast: false,
        accepted_for_scoring: true,
        quality_flags: [],
        ip_hash: "ip",
        user_agent_hash: "ua",
        raw_payload: {
          battle_id: "battle",
          left_item_id: left.id,
          right_item_id: right.id,
          winner_item_id: left.id,
          loser_item_id: right.id,
          vote_result: "winner",
        },
        storage: {
          mode: "local",
          path: "votes/v1/2026-06-22/summary-only-vote.json",
        },
      };
      await updateVoteSummary(dataset.datasetId, dataset.families, vote, left, right, left, right);

      const response = mockResponse();
      await handler({ method: "GET", headers: {}, query: { format: "json" } } as never, response as never);
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        voteCount: 0,
        rawVoteCount: 0,
        summaryVoteCount: 1,
        acceptedVoteCount: 1,
      });
      expect((response.body as { item_stats: unknown[] }).item_stats.length).toBeGreaterThan(0);
      expect((response.body as { pair_stats: unknown[] }).pair_stats.length).toBe(1);
    } finally {
      if (previousVoteDir === undefined) delete process.env.LOCAL_VOTE_DIR;
      else process.env.LOCAL_VOTE_DIR = previousVoteDir;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
