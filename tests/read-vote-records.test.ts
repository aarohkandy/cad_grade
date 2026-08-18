import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counting reads is the only way to see that `limit` bounds the work and not just the
// result, and the blob store must never be reachable from a test at all.
const reads = vi.hoisted(() => ({ count: 0 }));
const blobStore = vi.hoisted(() => ({
  objects: [] as Array<{ pathname: string; body: string }>,
  inFlight: 0,
  maxInFlight: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      reads.count += 1;
      return actual.readFile(...args);
    },
  };
});

vi.mock("@vercel/blob", () => ({
  list: async ({ prefix, limit, cursor }: { prefix: string; limit?: number; cursor?: string }) => {
    const matching = blobStore.objects.filter((object) => object.pathname.startsWith(prefix));
    const start = cursor ? Number(cursor) : 0;
    const page = matching.slice(start, start + Math.min(limit || 1000, 1000));
    const nextIndex = start + page.length;
    return {
      blobs: page.map((object) => ({ pathname: object.pathname })),
      cursor: nextIndex < matching.length ? String(nextIndex) : undefined,
      hasMore: nextIndex < matching.length,
    };
  },
  get: async (pathname: string) => {
    blobStore.inFlight += 1;
    blobStore.maxInFlight = Math.max(blobStore.maxInFlight, blobStore.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const object = blobStore.objects.find((candidate) => candidate.pathname === pathname);
      if (!object) return null;
      return { statusCode: 200, stream: new Response(object.body).body, blob: { etag: "etag" } };
    } finally {
      blobStore.inFlight -= 1;
    }
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

import { VOTE_READ_CONCURRENCY, loadVoteRecords, votePath } from "../src/server/voteStore";
import type { StoredVoteRecord } from "../src/server/voteStore";

function vote(index: number): StoredVoteRecord {
  const createdAt = new Date(Date.UTC(2026, 5, 12, 0, 0, 0) + index * 1000).toISOString();
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

describe("reading stored votes from disk", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cad-read-votes-"));
    process.env.LOCAL_VOTE_DIR = dir;
    reads.count = 0;
  });

  afterEach(async () => {
    delete process.env.LOCAL_VOTE_DIR;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function writeVotes(count: number): Promise<StoredVoteRecord[]> {
    const records = [];
    for (let index = 0; index < count; index += 1) {
      const record = vote(index);
      const filePath = join(dir, record.storage.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(record), "utf8");
      records.push(record);
    }
    return records;
  }

  it("skips a damaged record instead of failing the whole read", async () => {
    await writeVotes(5);
    const damaged = join(dir, "votes/v1/2026-06-12/2026-06-12T00-00-02-500Z_truncated.json");
    await writeFile(damaged, '{"id', "utf8");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await loadVoteRecords({ limit: 5 });
      expect(result.records).toHaveLength(4);
      expect(result.unreadableCount).toBe(1);
      expect(logged.mock.calls[0][0]).toContain("truncated.json");
    } finally {
      logged.mockRestore();
    }
  });

  it("reads only as many records as the limit asks for", async () => {
    const written = await writeVotes(300);
    reads.count = 0;

    const { records: rows } = await loadVoteRecords({ limit: 10 });

    expect(rows).toHaveLength(10);
    expect(reads.count).toBe(10);
    expect(rows.map((row) => row.id)).toEqual(
      written
        .slice(-10)
        .reverse()
        .map((row) => row.id),
    );
  });

  it("reports nothing unreadable on a clean store", async () => {
    await writeVotes(3);
    const result = await loadVoteRecords({});
    expect(result.records).toHaveLength(3);
    expect(result.unreadableCount).toBe(0);
  });
});

describe("reading stored votes from blob storage", () => {
  let previousToken: string | undefined;

  beforeEach(() => {
    previousToken = process.env.BLOB_READ_WRITE_TOKEN;
    process.env.BLOB_READ_WRITE_TOKEN = "stubbed-in-tests";
    blobStore.objects = [];
    blobStore.inFlight = 0;
    blobStore.maxInFlight = 0;
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
  });

  it("keeps the number of blob reads in flight bounded", async () => {
    blobStore.objects = Array.from({ length: 200 }, (_unused, index) => {
      const record = vote(index);
      return { pathname: record.storage.path, body: JSON.stringify(record) };
    });

    const result = await loadVoteRecords({});

    expect(result.records).toHaveLength(200);
    expect(blobStore.maxInFlight).toBeLessThanOrEqual(VOTE_READ_CONCURRENCY);
    // A serial read would also satisfy the cap, so pin that the pool is still a pool.
    expect(blobStore.maxInFlight).toBeGreaterThan(1);
  });

  it("skips a blob whose body will not parse", async () => {
    blobStore.objects = [0, 1].map((index) => {
      const record = vote(index);
      return { pathname: record.storage.path, body: JSON.stringify(record) };
    });
    blobStore.objects.push({ pathname: "votes/v1/2026-06-12/2026-06-12T00-00-09-000Z_bad.json", body: "{ not json" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await loadVoteRecords({});
      expect(result.records.map((row) => row.id)).toEqual(["vote-1", "vote-0"]);
      expect(result.unreadableCount).toBe(1);
      expect(logged.mock.calls[0][0]).toContain("_bad.json");
    } finally {
      logged.mockRestore();
    }
  });
});
