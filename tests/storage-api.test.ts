import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import exportHandler from "../api/export";
import statsHandler from "../api/stats";
import voteHandler from "../api/vote";
import { createHoldChallenge } from "../src/server/hold";
import { dataset } from "../src/server/items";
import type { VoteResponse } from "../src/shared/types";

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

async function submitVote(input: {
  leftItemId: string;
  rightItemId: string;
  winnerItemId: string | null;
  sessionId: string;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const voteResponse = mockResponse();
  await voteHandler(
    {
      method: "POST",
      headers: { "user-agent": "vitest" },
      socket: { remoteAddress: "127.0.0.1" },
      body: {
        battle_id: `battle-${input.sessionId}`,
        left_item_id: input.leftItemId,
        right_item_id: input.rightItemId,
        winner_item_id: input.winnerItemId,
        vote_result: input.winnerItemId ? "winner" : "draw",
        started_at: new Date(now - 6000).toISOString(),
        models_loaded_at: new Date(now - 5000).toISOString(),
        voted_at: new Date(now).toISOString(),
        session_id: input.sessionId,
      },
    } as never,
    voteResponse as never,
  );
  expect(voteResponse.statusCode).toBe(200);
  return voteResponse.body as VoteResponse;
}

describe("local storage api flow", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "capybara-arena-"));
    process.env.LOCAL_VOTE_DIR = tempDir;
    process.env.IP_HASH_SALT = "hash-secret";
    process.env.HOLD_VERIFY_SECRET = "hold-secret";
  });

  afterEach(async () => {
    delete process.env.LOCAL_VOTE_DIR;
    delete process.env.IP_HASH_SALT;
    delete process.env.HOLD_VERIFY_SECRET;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("saves, summarizes, and exports a vote", async () => {
    const items = dataset.items.filter((item) => item.family === "wall_planter");
    const [left, right] = items;
    const now = Date.now();
    const hold = createHoldChallenge("hold-secret", now - 1000, () => 0);
    const voteResponse = mockResponse();

    await voteHandler(
      {
        method: "POST",
        headers: { "user-agent": "vitest" },
        socket: { remoteAddress: "127.0.0.1" },
        body: {
          battle_id: "battle-test",
          left_item_id: left.id,
          right_item_id: right.id,
          winner_item_id: left.id,
          vote_result: "winner",
          started_at: new Date(now - 6000).toISOString(),
          models_loaded_at: new Date(now - 5000).toISOString(),
          voted_at: new Date(now).toISOString(),
          session_id: "session-1234567890",
          hold: {
            ...hold,
            heldMs: hold.targetMs,
          },
        },
      } as never,
      voteResponse as never,
    );

    expect(voteResponse.statusCode).toBe(200);
    expect(voteResponse.body).toMatchObject({
      saved: true,
      acceptedForScoring: true,
      dataMode: "local",
      crowd: {
        source: "elo",
        sampleSize: 0,
      },
    });
    expect((voteResponse.body as VoteResponse).crowd.agreementPercent).not.toBe(50);
    expect((voteResponse.body as VoteResponse).crowd.agreesWithMajority).toBe(
      (voteResponse.body as VoteResponse).crowd.agreementPercent > 50,
    );

    const statsResponse = mockResponse();
    await statsHandler({ method: "GET", headers: {}, query: {} } as never, statsResponse as never);
    expect(statsResponse.statusCode).toBe(200);
    expect(statsResponse.body).toMatchObject({ totalVotes: 1, acceptedVotes: 1 });

    const exportResponse = mockResponse();
    await exportHandler(
      {
        method: "GET",
        headers: {},
        query: { format: "json" },
      } as never,
      exportResponse as never,
    );
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.body).toMatchObject({ voteCount: 1 });
  });

  it("accepts a human-paced vote without a hold challenge", async () => {
    const items = dataset.items.filter((item) => item.family === "wall_hook");
    const [left, right] = items;
    const now = Date.now();
    const voteResponse = mockResponse();

    await voteHandler(
      {
        method: "POST",
        headers: { "user-agent": "vitest" },
        socket: { remoteAddress: "127.0.0.1" },
        body: {
          battle_id: "battle-no-hold",
          left_item_id: left.id,
          right_item_id: right.id,
          winner_item_id: right.id,
          vote_result: "winner",
          started_at: new Date(now - 6000).toISOString(),
          models_loaded_at: new Date(now - 5000).toISOString(),
          voted_at: new Date(now).toISOString(),
          session_id: "session-no-hold-1234567890",
        },
      } as never,
      voteResponse as never,
    );

    expect(voteResponse.statusCode).toBe(200);
    expect(voteResponse.body).toMatchObject({
      saved: true,
      acceptedForScoring: true,
      qualityFlags: [],
    });
  });

  it("accepts and summarizes a cross-family vote", async () => {
    const left = dataset.items.find((item) => item.family === "wall_planter");
    const right = dataset.items.find((item) => item.family === "wall_hook");
    if (!left || !right) throw new Error("missing test items");
    const now = Date.now();
    const voteResponse = mockResponse();

    await voteHandler(
      {
        method: "POST",
        headers: { "user-agent": "vitest" },
        socket: { remoteAddress: "127.0.0.1" },
        body: {
          battle_id: "battle-mixed",
          left_item_id: left.id,
          right_item_id: right.id,
          winner_item_id: right.id,
          vote_result: "winner",
          started_at: new Date(now - 6000).toISOString(),
          models_loaded_at: new Date(now - 5000).toISOString(),
          voted_at: new Date(now).toISOString(),
          session_id: "session-mixed-1234567890",
        },
      } as never,
      voteResponse as never,
    );

    expect(voteResponse.statusCode).toBe(200);
    expect(voteResponse.body).toMatchObject({ saved: true, acceptedForScoring: true, dataMode: "local" });

    const statsResponse = mockResponse();
    await statsHandler({ method: "GET", headers: {}, query: {} } as never, statsResponse as never);
    expect(statsResponse.statusCode).toBe(200);
    expect(statsResponse.body).toMatchObject({
      totalVotes: 1,
      acceptedVotes: 1,
      mixedVoteCount: 1,
      mixedAcceptedVoteCount: 1,
    });
  });

  it("uses direct pair history for crowd agreement once enough votes exist", async () => {
    const items = dataset.items.filter((item) => item.family === "snowman");
    const [left, right] = items;
    const now = Date.now();

    for (let index = 0; index < 5; index += 1) {
      await submitVote({
        leftItemId: left.id,
        rightItemId: right.id,
        winnerItemId: left.id,
        sessionId: `session-majority-${index}`,
        now: now + index,
      });
    }

    const minority = await submitVote({
      leftItemId: left.id,
      rightItemId: right.id,
      winnerItemId: right.id,
      sessionId: "session-minority-choice",
      now: now + 10,
    });

    expect(minority.crowd).toMatchObject({
      agreesWithMajority: false,
      source: "direct",
      sampleSize: 5,
    });
    expect(minority.crowd.agreementPercent).toBeGreaterThan(4);
    expect(minority.crowd.agreementPercent).toBeLessThan(50);
  });

  it("saves draw votes as tie judgments", async () => {
    const items = dataset.items.filter((item) => item.family === "wall_hook");
    const [left, right] = items.slice(2);
    const now = Date.now();
    const voteResponse = mockResponse();

    await voteHandler(
      {
        method: "POST",
        headers: { "user-agent": "vitest" },
        socket: { remoteAddress: "127.0.0.1" },
        body: {
          battle_id: "battle-draw",
          left_item_id: left.id,
          right_item_id: right.id,
          winner_item_id: null,
          vote_result: "draw",
          started_at: new Date(now - 6000).toISOString(),
          models_loaded_at: new Date(now - 5000).toISOString(),
          voted_at: new Date(now).toISOString(),
          session_id: "session-draw-1234567890",
        },
      } as never,
      voteResponse as never,
    );

    expect(voteResponse.statusCode).toBe(200);
    expect(voteResponse.body).toMatchObject({
      saved: true,
      acceptedForScoring: true,
    });
    expect((voteResponse.body as VoteResponse).agreementLabel.toLowerCase()).toContain("tie");

    const statsResponse = mockResponse();
    await statsHandler({ method: "GET", headers: {}, query: {} } as never, statsResponse as never);
    expect(statsResponse.body).toMatchObject({ totalVotes: 1, acceptedVotes: 1 });
  });
});
