import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import voteHandler from "../api/vote";
import { createHoldChallenge } from "../src/server/hold";
import { dataset } from "../src/server/items";
import { VOTES_PREFIX, type StoredVoteRecord } from "../src/server/voteStore";
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

async function post(body: unknown) {
  const response = mockResponse();
  await voteHandler(
    {
      method: "POST",
      headers: { "user-agent": "vitest" },
      socket: { remoteAddress: "127.0.0.1" },
      body,
    } as never,
    response as never,
  );
  return response;
}

// Read the raw JSON off disk rather than through loadVoteRecords: what matters here is
// exactly what was written, including fields the reader would happily hand back untyped.
async function storedVotes(root: string): Promise<StoredVoteRecord[]> {
  const votesDir = join(root, VOTES_PREFIX);
  const names = await readdir(votesDir, { recursive: true }).catch(() => [] as string[]);
  const files = names.filter((name) => name.endsWith(".json"));
  return Promise.all(files.map(async (name) => JSON.parse(await readFile(join(votesDir, name), "utf8"))));
}

describe("vote payload validation", () => {
  const [left, right] = dataset.items.filter((item) => item.family === "snowman");
  let tempDir = "";
  let now = 0;

  function humanPacedVote(overrides: Record<string, unknown> = {}) {
    return {
      battle_id: "battle-validation",
      left_item_id: left.id,
      right_item_id: right.id,
      winner_item_id: left.id,
      vote_result: "winner",
      started_at: new Date(now - 6000).toISOString(),
      models_loaded_at: new Date(now - 5000).toISOString(),
      voted_at: new Date(now).toISOString(),
      session_id: "session-validation-1",
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "capybara-validation-"));
    now = Date.now();
    process.env.LOCAL_VOTE_DIR = tempDir;
    process.env.IP_HASH_SALT = "hash-secret";
    process.env.HOLD_VERIFY_SECRET = "hold-secret";
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });

  afterEach(async () => {
    delete process.env.LOCAL_VOTE_DIR;
    delete process.env.IP_HASH_SALT;
    delete process.env.HOLD_VERIFY_SECRET;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("treats a numeric session id as weak, the same as a short one", async () => {
    const response = await post(humanPacedVote({ session_id: 999999 }));

    expect(response.statusCode).toBe(200);
    const body = response.body as VoteResponse;
    expect(body.acceptedForScoring).toBe(false);
    expect(body.qualityFlags).toContain("weak_session");
    expect(body.qualityFlags).toContain("hold_required");

    const [stored] = await storedVotes(tempDir);
    expect(stored.session_id).toBe("999999");
    expect(stored.accepted_for_scoring).toBe(false);
    expect(stored.quality_flags).toContain("weak_session");
  });

  // The interesting number is not 12345 but Date.now(): thirteen digits, so coercing to a
  // string and measuring the length would call it a perfectly good session id.
  it("treats a timestamp-shaped numeric session id as weak", async () => {
    const response = await post(humanPacedVote({ session_id: 1755500000000 }));

    expect(response.statusCode).toBe(200);
    expect((response.body as VoteResponse).acceptedForScoring).toBe(false);
    expect((response.body as VoteResponse).qualityFlags).toContain("weak_session");
  });

  it("still accepts an ordinary session id", async () => {
    const response = await post(humanPacedVote({ session_id: "b31de0a8-0d4c-4d21-9a86-7f3f5c2f4c11" }));

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ saved: true, acceptedForScoring: true, qualityFlags: [] });
  });

  it("refuses a session id that is not a scalar", async () => {
    const response = await post(humanPacedVote({ session_id: { id: "session-1234567890" } }));

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "invalid_payload" });
    expect(await storedVotes(tempDir)).toHaveLength(0);
  });

  it("refuses a battle id far longer than any battle the arena issues", async () => {
    const response = await post(humanPacedVote({ battle_id: "x".repeat(200_000) }));

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "invalid_payload" });
    expect(await storedVotes(tempDir)).toHaveLength(0);
  });

  it("answers malformed JSON with a client error", async () => {
    const response = await post("{not json");

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "invalid_json" });
  });

  it("answers a JSON body that is not an object with a client error", async () => {
    const response = await post("null");

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "invalid_payload" });
  });

  // Not knowing how long a vote took is not the same as knowing it was unhurried, so an
  // unparseable timestamp costs the vote its place in the scoring set the way too_fast does.
  it("stores an unparseable timestamp as no timing, flagged and unscored", async () => {
    const response = await post(humanPacedVote({ voted_at: "whenever", session_id: "session-bad-timestamp" }));

    expect(response.statusCode).toBe(200);
    const body = response.body as VoteResponse;
    expect(body.qualityFlags).toContain("bad_timestamps");
    expect(body.acceptedForScoring).toBe(false);

    const [stored] = await storedVotes(tempDir);
    expect(stored.voted_at).toBe("whenever");
    expect(stored.elapsed_ms).toBeNull();
    expect(stored.quality_flags).toContain("bad_timestamps");
    expect(stored.accepted_for_scoring).toBe(false);
  });

  it("does not let a hold with a junk heldMs clear the challenge", async () => {
    const challenge = createHoldChallenge("hold-secret", now - 1000, () => 0);
    const response = await post(
      humanPacedVote({
        session_id: "session-junk-hold-1",
        started_at: new Date(now - 500).toISOString(),
        models_loaded_at: new Date(now - 400).toISOString(),
        hold: { ...challenge, heldMs: "abc" },
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.body as VoteResponse;
    expect(body.acceptedForScoring).toBe(false);
    expect(body.qualityFlags).toContain("bad_hold_payload");

    const [stored] = await storedVotes(tempDir);
    expect(stored.hold_passed).toBe(false);
    expect(stored.hold_duration_ms).toBe(0);
  });

  // The arena sends an object or null. A scalar is neither a submission nor a failed one,
  // so it reads as absent rather than costing an otherwise clean vote its acceptance.
  it("reads a scalar hold as no hold at all", async () => {
    const response = await post(humanPacedVote({ session_id: "session-scalar-hold-1", hold: false }));

    expect(response.statusCode).toBe(200);
    const body = response.body as VoteResponse;
    expect(body.acceptedForScoring).toBe(true);
    expect(body.qualityFlags).toEqual([]);

    const [stored] = await storedVotes(tempDir);
    expect(stored.hold_duration_ms).toBeNull();
  });

  it("accepts the same fast vote when the hold is real", async () => {
    const challenge = createHoldChallenge("hold-secret", now - 1000, () => 0, "battle-validation");
    const response = await post(
      humanPacedVote({
        session_id: "session-real-hold-1",
        started_at: new Date(now - 500).toISOString(),
        models_loaded_at: new Date(now - 400).toISOString(),
        hold: { ...challenge, heldMs: challenge.targetMs },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect((response.body as VoteResponse).acceptedForScoring).toBe(true);
  });
});
