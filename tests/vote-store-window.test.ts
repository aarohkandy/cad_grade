import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A listing page carries pathnames and no object bodies, so counting GETs separately from
// list calls is what distinguishes "found the newest ten" from "read the whole store".
const blobStore = vi.hoisted(() => ({
  objects: [] as Array<{ pathname: string; body: string; unavailable?: boolean }>,
  gets: 0,
  listCalls: 0,
  // A finished listing that still hands back a cursor. Real listings should not do this,
  // but the reader is the only thing standing between "should not" and a loop with no exit
  // inside a ten-second function, so the stub gives up loudly instead of spinning.
  cursorPastTheEnd: false,
}));

vi.mock("@vercel/blob", () => ({
  list: async ({ prefix, limit, cursor }: { prefix: string; limit?: number; cursor?: string }) => {
    blobStore.listCalls += 1;
    if (blobStore.listCalls > 20) throw new Error("listing never stopped");
    const matching = blobStore.objects.filter((object) => object.pathname.startsWith(prefix));
    const start = cursor ? Number(cursor) : 0;
    const page = matching.slice(start, start + Math.min(limit || 1000, 1000));
    const nextIndex = start + page.length;
    const hasMore = nextIndex < matching.length;
    return {
      blobs: page.map((object) => ({ pathname: object.pathname })),
      cursor: hasMore || blobStore.cursorPastTheEnd ? String(nextIndex) : undefined,
      hasMore,
    };
  },
  get: async (pathname: string) => {
    blobStore.gets += 1;
    const object = blobStore.objects.find((candidate) => candidate.pathname === pathname);
    if (!object) return null;
    // What the client does when the store answers but the object is not there to give: no
    // throw, no stream, just a status the caller has to notice.
    if (object.unavailable) return { statusCode: 503, stream: null, blob: { etag: "etag" } };
    return { statusCode: 200, stream: new Response(object.body).body, blob: { etag: "etag" } };
  },
  put: async () => {
    throw new Error("blob writes are stubbed in tests");
  },
  head: async () => {
    throw new Error("blob access is stubbed in tests");
  },
  del: async () => {
    throw new Error("del must never be called from a test");
  },
}));

import { loadVoteRecords, votePath } from "../src/server/voteStore";
import type { StoredVoteRecord } from "../src/server/voteStore";

// A minute apart, so 2,500 votes land across three day folders and a correct answer has to
// order pathnames across directories rather than inside one.
function vote(index: number): StoredVoteRecord {
  const createdAt = new Date(Date.UTC(2026, 5, 12, 0, 0, 0) + index * 60_000).toISOString();
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
    storage: { mode: "local", path: votePath(createdAt, `vote-${String(index).padStart(5, "0")}`) },
  };
}

function newestIds(count: number, total: number): string[] {
  return Array.from({ length: count }, (_unused, offset) => `vote-${total - 1 - offset}`);
}

describe("which end of the store a limit reads", () => {
  const STORE_SIZE = 2500;
  let previousToken: string | undefined;
  let dir = "";

  beforeEach(async () => {
    previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    blobStore.objects = [];
    blobStore.gets = 0;
    blobStore.listCalls = 0;
    blobStore.cursorPastTheEnd = false;
    dir = "";
  });

  afterEach(async () => {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    delete process.env.LOCAL_VOTE_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function seedBlobs(count: number): void {
    process.env.BLOB_READ_WRITE_TOKEN = "stubbed-in-tests";
    blobStore.objects = Array.from({ length: count }, (_unused, index) => {
      const record = vote(index);
      return { pathname: record.storage.path, body: JSON.stringify(record) };
    });
  }

  async function seedFiles(count: number): Promise<void> {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    dir = await mkdtemp(join(tmpdir(), "cad-vote-window-"));
    process.env.LOCAL_VOTE_DIR = dir;
    for (let index = 0; index < count; index += 1) {
      const record = vote(index);
      const filePath = join(dir, record.storage.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(record), "utf8");
    }
  }

  it("returns the newest votes in blob storage, not the first listing page", async () => {
    seedBlobs(STORE_SIZE);

    const result = await loadVoteRecords({ limit: 10 });

    expect(result.records.map((record) => record.id)).toEqual(newestIds(10, STORE_SIZE));
  });

  it("pays for the whole store in listings, not in object reads", async () => {
    seedBlobs(STORE_SIZE);

    await loadVoteRecords({ limit: 10 });

    expect(blobStore.gets).toBe(10);
    expect(blobStore.listCalls).toBe(Math.ceil(STORE_SIZE / 1000));
  });

  it("means the same thing on a dev machine and on the deployment", async () => {
    seedBlobs(STORE_SIZE);
    const fromBlobs = await loadVoteRecords({ limit: 25 });

    await seedFiles(STORE_SIZE);
    const fromFiles = await loadVoteRecords({ limit: 25 });

    expect(fromFiles.records.map((record) => record.id)).toEqual(fromBlobs.records.map((record) => record.id));
    expect(fromBlobs.records.map((record) => record.id)).toEqual(newestIds(25, STORE_SIZE));
  });

  it("still costs one vote and not the request when an object will not parse", async () => {
    seedBlobs(STORE_SIZE);
    const damaged = blobStore.objects[STORE_SIZE - 3];
    damaged.body = '{"id": "vote-';
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await loadVoteRecords({ limit: 5 });
      expect(result.records.map((record) => record.id)).toEqual(["vote-2499", "vote-2498", "vote-2496", "vote-2495"]);
      expect(result.unreadableCount).toBe(1);
      expect(logged.mock.calls[0][0]).toContain(damaged.pathname);
    } finally {
      logged.mockRestore();
    }
  });

  // The listing loop's only bound is what the service tells it. Trusting the cursor alone
  // means a service that keeps handing one back never lets the request finish.
  it("stops listing when the store says there is no more, cursor or not", async () => {
    seedBlobs(40);
    blobStore.cursorPastTheEnd = true;

    const result = await loadVoteRecords({ limit: 5 });

    expect(result.records.map((record) => record.id)).toEqual(newestIds(5, 40));
    expect(blobStore.listCalls).toBe(1);
  });

  // A blob that the listing knows about but that get() will not hand over comes back as no
  // value rather than as a throw, so it used to leave the window one record short with
  // unreadableCount: 0. Local mode counts the same loss, and the two modes have to agree
  // about it or the number in the export means nothing.
  it("counts an object the store lists but will not hand back", async () => {
    seedBlobs(STORE_SIZE);
    const missing = blobStore.objects[STORE_SIZE - 3];
    missing.unavailable = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await loadVoteRecords({ limit: 5 });
      expect(result.records.map((record) => record.id)).toEqual(["vote-2499", "vote-2498", "vote-2496", "vote-2495"]);
      expect(result.unreadableCount).toBe(1);
      expect(logged.mock.calls[0][0]).toContain(missing.pathname);
    } finally {
      logged.mockRestore();
    }
  });
});
