import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import handler from "../api/export";
import { dataset } from "../src/server/items";
import {
  SUMMARY_PATH,
  updateVoteSummary,
  votePath,
  writeVoteRecord,
  type StoredVoteRecord,
} from "../src/server/voteStore";
import type { ArenaItem } from "../src/shared/types";

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

function storedVote(id: string, left: ArenaItem, right: ArenaItem): StoredVoteRecord {
  return {
    id,
    created_at: "2026-06-22T20:00:00.000Z",
    dataset_id: dataset.datasetId,
    battle_id: "battle",
    family: "wall_hook",
    left_item_id: left.id,
    right_item_id: right.id,
    winner_item_id: left.id,
    loser_item_id: right.id,
    vote_result: "winner",
    session_id: `session-${id}`,
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
      path: `votes/v1/2026-06-22/${id}.json`,
    },
  };
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
      const vote = storedVote("summary-only-vote", left, right);
      await updateVoteSummary(dataset.datasetId, dataset.families, vote, left, right, left, right);

      const response = mockResponse();
      await handler({ method: "GET", headers: {}, query: { format: "json" } } as never, response as never);
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        voteCount: 0,
        rawVoteCount: 0,
        summaryAvailable: true,
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

  it("answers 400 for a date that is not a calendar day", async () => {
    for (const date of ["../../../../etc", "2026-6-1", "yesterday"]) {
      const response = mockResponse();
      await handler({ method: "GET", headers: {}, query: { date } } as never, response as never);
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ error: "invalid_date" });
    }
  });

  it("answers 400 for a limit that is not a positive whole number", async () => {
    for (const limit of ["abc", "-5", "0", "2.5"]) {
      const response = mockResponse();
      await handler({ method: "GET", headers: {}, query: { limit } } as never, response as never);
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ error: "invalid_limit" });
    }
  });

  it("still serves a well-formed date and limit", async () => {
    const response = mockResponse();
    await handler(
      { method: "GET", headers: {}, query: { date: "2026-06-22", limit: "25" } } as never,
      response as never,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ date: "2026-06-22" });
  });

  it("treats a present but empty date or limit as absent", async () => {
    for (const query of [{ date: "" }, { limit: "" }, { date: "", limit: "" }]) {
      const response = mockResponse();
      await handler({ method: "GET", headers: {}, query } as never, response as never);
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ date: null });
    }
  });

  it("reports the damaged records it skipped instead of failing the pull", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cad-export-damaged-"));
    const previousVoteDir = process.env.LOCAL_VOTE_DIR;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.LOCAL_VOTE_DIR = tempDir;
      const [left, right] = dataset.items.filter((item) => item.family === "wall_hook");
      for (const id of ["kept-vote-a", "kept-vote-b"]) {
        const vote = storedVote(id, left, right);
        vote.storage.path = votePath(vote.created_at, id);
        await writeVoteRecord(vote);
      }

      const damaged = join(tempDir, votePath("2026-06-22T20:00:01.000Z", "truncated"));
      await mkdir(dirname(damaged), { recursive: true });
      await writeFile(damaged, '{"id": "trunc', "utf8");

      const response = mockResponse();
      await handler({ method: "GET", headers: {}, query: { format: "json" } } as never, response as never);
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ rawVoteCount: 2, unreadableCount: 1 });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      if (previousVoteDir === undefined) delete process.env.LOCAL_VOTE_DIR;
      else process.env.LOCAL_VOTE_DIR = previousVoteDir;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("still hands over the raw votes when the stored summary cannot be read", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cad-export-broken-"));
    const previousVoteDir = process.env.LOCAL_VOTE_DIR;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.LOCAL_VOTE_DIR = tempDir;
      const [left, right] = dataset.items.filter((item) => item.family === "wall_hook");
      const vote = storedVote("broken-summary-vote", left, right);
      await writeVoteRecord(vote);

      const summaryFile = join(tempDir, SUMMARY_PATH);
      await mkdir(dirname(summaryFile), { recursive: true });
      await writeFile(summaryFile, "{ not json", "utf8");

      const response = mockResponse();
      await handler({ method: "GET", headers: {}, query: { format: "json" } } as never, response as never);
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        summaryAvailable: false,
        rawVoteCount: 1,
        summaryVoteCount: 1,
        acceptedVoteCount: 1,
      });
      expect((response.body as { votes: StoredVoteRecord[] }).votes[0].id).toBe("broken-summary-vote");
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      if (previousVoteDir === undefined) delete process.env.LOCAL_VOTE_DIR;
      else process.env.LOCAL_VOTE_DIR = previousVoteDir;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
