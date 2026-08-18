import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import voteHandler from "../api/vote";
import { dataset } from "../src/server/items";
import { markSessionPair, readVoteRecords, readVoteSummary, updateVoteSummary } from "../src/server/voteStore";

vi.mock("../src/server/voteStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/voteStore")>();
  return {
    ...actual,
    markSessionPair: vi.fn(actual.markSessionPair),
    readVoteSummary: vi.fn(actual.readVoteSummary),
    updateVoteSummary: vi.fn(actual.updateVoteSummary),
  };
});

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

function votePayload(leftId: string, rightId: string, battleId: string, sessionId: string, now: number) {
  return {
    battle_id: battleId,
    left_item_id: leftId,
    right_item_id: rightId,
    winner_item_id: leftId,
    vote_result: "winner",
    started_at: new Date(now - 6000).toISOString(),
    models_loaded_at: new Date(now - 5000).toISOString(),
    voted_at: new Date(now).toISOString(),
    session_id: sessionId,
  };
}

describe("vote api with a broken summary", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "capybara-degraded-"));
    process.env.LOCAL_VOTE_DIR = tempDir;
    process.env.IP_HASH_SALT = "hash-secret";
  });

  afterEach(async () => {
    delete process.env.LOCAL_VOTE_DIR;
    delete process.env.IP_HASH_SALT;
    vi.restoreAllMocks();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the vote, keeps the 200, and flags the stale summary when the write fails", async () => {
    const [left, right] = dataset.items.filter((item) => item.family === "wall_hook");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = mockResponse();
    vi.mocked(updateVoteSummary).mockRejectedValueOnce(new Error("summary blob write rejected"));

    await voteHandler(
      {
        method: "POST",
        headers: { "user-agent": "vitest" },
        socket: { remoteAddress: "127.0.0.1" },
        body: votePayload(left.id, right.id, "battle-degraded", "session-degraded-1234567890", Date.now()),
      } as never,
      response as never,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ saved: true, summaryUpdated: false });
    expect(logged).toHaveBeenCalled();

    // The blob is the source of truth, so the vote itself must survive.
    const stored = await readVoteRecords({});
    expect(stored).toHaveLength(1);
    expect(stored[0].winner_item_id).toBe(left.id);
  });

  it("keeps the vote and the 200 when the session pair marker cannot be written", async () => {
    const [left, right] = dataset.items.filter((item) => item.family === "wall_planter");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = mockResponse();
    // Two tabs voting on the same pair race here, and the loser gets EEXIST. Before this was
    // caught it 500d a request whose vote was already on disk, so the voter voted again.
    vi.mocked(markSessionPair).mockRejectedValueOnce(new Error("EEXIST: file already exists"));

    await voteHandler(
      {
        method: "POST",
        headers: { "user-agent": "vitest" },
        socket: { remoteAddress: "127.0.0.1" },
        body: votePayload(left.id, right.id, "battle-marker-fail", "session-markerfail-1234567890", Date.now()),
      } as never,
      response as never,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ saved: true });
    expect(logged).toHaveBeenCalled();

    const stored = await readVoteRecords({});
    expect(stored).toHaveLength(1);
    expect(stored[0].winner_item_id).toBe(left.id);
  });

  it("keeps the vote and the 200 when reading the prior summary fails", async () => {
    const [left, right] = dataset.items.filter((item) => item.family === "snowman");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = mockResponse();
    vi.mocked(readVoteSummary).mockRejectedValueOnce(new Error("summary blob read rejected"));

    await voteHandler(
      {
        method: "POST",
        headers: { "user-agent": "vitest" },
        socket: { remoteAddress: "127.0.0.1" },
        body: votePayload(left.id, right.id, "battle-read-fail", "session-readfail-1234567890", Date.now()),
      } as never,
      response as never,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ saved: true, summaryUpdated: false });
    expect(logged).toHaveBeenCalled();

    const stored = await readVoteRecords({});
    expect(stored).toHaveLength(1);
    expect(stored[0].winner_item_id).toBe(left.id);
  });
});
