import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

// backupLive() reaches the real Vercel Blob client whenever a token is in scope, and del()
// is not recoverable. Stub the module for the whole file so no test in it can ever delete a
// production vote blob, whatever is in .env.local on the machine running `npm test`.
vi.mock("@vercel/blob", () => ({
  list: async () => {
    throw new Error("blob access is stubbed in tests");
  },
  get: async () => {
    throw new Error("blob access is stubbed in tests");
  },
  del: async () => {
    throw new Error("del must never be called from a test");
  },
}));

import {
  backupLive,
  completedHourCutoff,
  deleteRemoteVotePaths,
  isProtectedBlobPath,
  listVoteRecordsFromExport,
  mergeDailyVotes,
  pruneCandidatesForCompletedHour,
  verifyPruneSafety,
  writeBackupFiles,
} from "../scripts/backup-live.mjs";
import { readJsonl } from "../scripts/analysis-core.mjs";

function vote(id, createdAt = "2026-06-14T19:30:00.000Z") {
  return {
    id,
    created_at: createdAt,
    family: "wall_planter",
    left_item_id: "a",
    right_item_id: "b",
    winner_item_id: "a",
    loser_item_id: "b",
    vote_result: "winner",
    session_id: `session-${id}`,
    accepted_for_scoring: true,
    quality_flags: [],
    storage: { mode: "blob", path: `votes/v1/2026-06-14/${id}.json` },
  };
}

describe("live backup helpers", () => {
  it("knows the current UTC hour cutoff", () => {
    expect(completedHourCutoff(new Date("2026-06-14T20:42:11.000Z")).toISOString()).toBe("2026-06-14T20:00:00.000Z");
  });

  it("protects non-raw-vote blob paths", () => {
    expect(isProtectedBlobPath("votes/v1/2026-06-14/a.json")).toBe(false);
    expect(isProtectedBlobPath("derived/v1/stats-summary.json")).toBe(true);
    expect(isProtectedBlobPath("session-pairs/v1/session/pair.json")).toBe(true);
    expect(isProtectedBlobPath("other/path.json")).toBe(true);
  });

  it("dedupes daily files across repeated pulls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cad-backup-"));
    try {
      await mergeDailyVotes(dir, [vote("a"), vote("b")]);
      await mergeDailyVotes(dir, [vote("a"), vote("c")]);
      const rows = await readJsonl(join(dir, "daily", "votes-2026-06-14.jsonl"));
      expect(rows.map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
      const index = JSON.parse(await readFile(join(dir, "index", "seen-vote-ids.json"), "utf8"));
      expect(index.voteCount).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes snapshot, daily files, and a manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cad-backup-"));
    try {
      const result = await writeBackupFiles({
        outRoot: dir,
        baseUrl: "https://cadbattle.vercel.app",
        health: { ready: true },
        stats: { totalVotes: 2 },
        exportPayload: { rawVoteCount: 2, summaryVoteCount: 4, acceptedVoteCount: 3, item_stats: [{ item_id: "a" }] },
        records: [
          { vote: vote("a"), pathname: "votes/v1/2026-06-14/a.json" },
          { vote: vote("b"), pathname: "votes/v1/2026-06-14/b.json" },
        ],
        now: new Date("2026-06-14T20:42:00.000Z"),
      });
      expect(result.manifest.pulledVoteCount).toBe(2);
      expect(result.manifest.summaryVoteCount).toBe(4);
      expect(await readFile(join(result.snapshotDir, "manifest.json"), "utf8")).toContain("pulledVoteCount");
      expect(await readFile(join(result.snapshotDir, "export.json"), "utf8")).toContain("item_stats");
      expect((await readJsonl(join(dir, "daily", "votes-2026-06-14.jsonl"))).length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can build backup records from the export endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      expect(String(url)).toContain("/api/export");
      return new Response(JSON.stringify({ votes: [vote("exported")] }), { status: 200 });
    };
    try {
      const records = await listVoteRecordsFromExport({ baseUrl: "https://cadbattle.vercel.app" });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ pathname: "votes/v1/2026-06-14/exported.json" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("can ask the deployed app to prune verified vote paths", async () => {
    const originalFetch = globalThis.fetch;
    const originalSecret = process.env.PRUNE_SECRET;
    process.env.PRUNE_SECRET = "prune-secret-value";
    globalThis.fetch = async (url, options) => {
      expect(String(url)).toBe("https://cadbattle.vercel.app/api/prune-votes");
      expect(options.method).toBe("POST");
      expect(options.headers["x-prune-secret"]).toBe("prune-secret-value");
      expect(JSON.parse(options.body)).toEqual({ paths: ["votes/v1/2026-06-14/old.json"] });
      return new Response(JSON.stringify({ deleted: ["votes/v1/2026-06-14/old.json"], failed: [] }), { status: 200 });
    };
    try {
      const result = await deleteRemoteVotePaths({
        baseUrl: "https://cadbattle.vercel.app",
        paths: ["votes/v1/2026-06-14/old.json"],
      });
      expect(result).toEqual({ deleted: ["votes/v1/2026-06-14/old.json"], failed: [] });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.PRUNE_SECRET;
      else process.env.PRUNE_SECRET = originalSecret;
    }
  });

  it("fails loudly instead of skipping the prune when PRUNE_SECRET is missing", async () => {
    const originalFetch = globalThis.fetch;
    const originalSecret = process.env.PRUNE_SECRET;
    delete process.env.PRUNE_SECRET;
    globalThis.fetch = async () => {
      throw new Error("prune request must not be sent without a secret");
    };
    try {
      await expect(
        deleteRemoteVotePaths({
          baseUrl: "https://cadbattle.vercel.app",
          paths: ["votes/v1/2026-06-14/old.json"],
        }),
      ).rejects.toThrow(/PRUNE_SECRET/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret !== undefined) process.env.PRUNE_SECRET = originalSecret;
    }
  });

  it("spreads a large prune backlog over several requests", async () => {
    const originalFetch = globalThis.fetch;
    const originalSecret = process.env.PRUNE_SECRET;
    process.env.PRUNE_SECRET = "prune-secret-value";
    const paths = Array.from({ length: 450 }, (_unused, index) => `votes/v1/2026-06-14/old-${index}.json`);
    const batchSizes = [];
    globalThis.fetch = async (url, options) => {
      const sent = JSON.parse(options.body).paths;
      batchSizes.push(sent.length);
      return new Response(JSON.stringify({ deleted: sent, failed: [], skippedCount: 0 }), { status: 200 });
    };
    try {
      const result = await deleteRemoteVotePaths({ baseUrl: "https://cadbattle.vercel.app", paths });
      expect(batchSizes).toEqual([200, 200, 50]);
      expect(result.deleted).toEqual(paths);
      expect(result.failed).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.PRUNE_SECRET;
      else process.env.PRUNE_SECRET = originalSecret;
    }
  });

  it("keeps the paths a partly failed prune really deleted", async () => {
    const originalFetch = globalThis.fetch;
    const originalSecret = process.env.PRUNE_SECRET;
    process.env.PRUNE_SECRET = "prune-secret-value";
    const paths = Array.from({ length: 300 }, (_unused, index) => `votes/v1/2026-06-14/old-${index}.json`);
    let call = 0;
    globalThis.fetch = async (url, options) => {
      call += 1;
      if (call === 2) return new Response("upstream exploded", { status: 500 });
      const sent = JSON.parse(options.body).paths;
      return new Response(JSON.stringify({ deleted: sent, failed: [] }), { status: 200 });
    };
    try {
      const result = await deleteRemoteVotePaths({ baseUrl: "https://cadbattle.vercel.app", paths });
      expect(result.deleted).toEqual(paths.slice(0, 200));
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].paths).toEqual(paths.slice(200));
      expect(result.failed[0].error).toMatch(/500/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.PRUNE_SECRET;
      else process.env.PRUNE_SECRET = originalSecret;
    }
  });

  it("keeps the deleted list out of a 500 that only half failed", async () => {
    const originalFetch = globalThis.fetch;
    const originalSecret = process.env.PRUNE_SECRET;
    process.env.PRUNE_SECRET = "prune-secret-value";
    const paths = Array.from({ length: 150 }, (_unused, index) => `votes/v1/2026-06-14/old-${index}.json`);
    globalThis.fetch = async (url, options) => {
      const sent = JSON.parse(options.body).paths;
      return new Response(
        JSON.stringify({
          deleted: sent.slice(0, 100),
          deletedCount: 100,
          failed: [{ paths: sent.slice(100), error: "blob store rejected the batch" }],
        }),
        { status: 500 },
      );
    };
    try {
      const result = await deleteRemoteVotePaths({ baseUrl: "https://cadbattle.vercel.app", paths });
      expect(result.deleted).toEqual(paths.slice(0, 100));
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].paths).toEqual(paths.slice(100));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.PRUNE_SECRET;
      else process.env.PRUNE_SECRET = originalSecret;
    }
  });

  it("reports paths the deployment answered 200 for but never accounted for", async () => {
    const originalFetch = globalThis.fetch;
    const originalSecret = process.env.PRUNE_SECRET;
    process.env.PRUNE_SECRET = "prune-secret-value";
    // The deployment re-runs its own path filter on its own clock, so a minute of skew makes
    // it silently keep the newest path and still answer 200 with an empty failed list.
    globalThis.fetch = async (url, options) => {
      const sent = JSON.parse(options.body).paths;
      return new Response(JSON.stringify({ deleted: sent.slice(0, 1), failed: [] }), { status: 200 });
    };
    try {
      const result = await deleteRemoteVotePaths({
        baseUrl: "https://cadbattle.vercel.app",
        paths: Array.from({ length: 5 }, (_unused, index) => `votes/v1/2026-06-14/old-${index}.json`),
      });
      expect(result.deleted).toEqual(["votes/v1/2026-06-14/old-0.json"]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].paths).toEqual([
        "votes/v1/2026-06-14/old-1.json",
        "votes/v1/2026-06-14/old-2.json",
        "votes/v1/2026-06-14/old-3.json",
        "votes/v1/2026-06-14/old-4.json",
      ]);
      expect(result.failed[0].error).toMatch(/neither deleted nor reported 4 of 5/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.PRUNE_SECRET;
      else process.env.PRUNE_SECRET = originalSecret;
    }
  });

  it("still archives the votes when the deployment's health and stats endpoints are down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cad-backup-"));
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("/api/export")) {
        return new Response(JSON.stringify({ votes: [vote("old")] }), { status: 200 });
      }
      if (href.includes("/api/health")) return new Response("storage unreadable", { status: 503 });
      if (href.includes("/api/stats")) return new Response('{"error":"stats_failed"}', { status: 500 });
      throw new Error(`unexpected fetch ${href}`);
    };
    try {
      const result = await backupLive({
        baseUrl: "https://cadbattle.vercel.app",
        outRoot: dir,
        prune: "none",
        shouldProcess: false,
        loadEnv: false,
        now: new Date("2026-06-14T20:42:00.000Z"),
      });

      // A deployment sick enough to need an emergency backup is one whose health and stats
      // endpoints are already 5xx. Losing the votes over that is the wrong trade.
      expect(result.recordCount).toBe(1);
      expect(result.manifest.endpointErrors).toHaveLength(2);
      expect(result.manifest.endpointErrors.join(" ")).toMatch(/503/);
      const rows = await readJsonl(join(result.snapshotDir, "votes.jsonl"));
      expect(rows.map((row) => row.id)).toEqual(["old"]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = originalToken;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a failed prune in the manifest instead of abandoning the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cad-backup-"));
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
    const originalSecret = process.env.PRUNE_SECRET;
    // No blob token forces the /api/export fallback, which is the only path that asks the
    // deployed app to prune — and the only one that needs PRUNE_SECRET. loadEnv: false below
    // is what makes that hold: without it backupLive reads .env.local and hands both keys
    // back, and a run on a machine with real credentials would delete real vote blobs.
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.PRUNE_SECRET;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes("/api/export")) {
        return new Response(JSON.stringify({ votes: [vote("old")] }), { status: 200 });
      }
      if (href.includes("/api/health")) return new Response(JSON.stringify({ ready: true }), { status: 200 });
      if (href.includes("/api/stats")) return new Response(JSON.stringify({ totalVotes: 1 }), { status: 200 });
      throw new Error(`unexpected fetch ${href}`);
    };
    try {
      await expect(
        backupLive({
          baseUrl: "https://cadbattle.vercel.app",
          outRoot: dir,
          prune: "completed-hour",
          shouldProcess: false,
          loadEnv: false,
          now: new Date("2026-06-14T20:42:00.000Z"),
        }),
      ).rejects.toThrow(/PRUNE_SECRET/);

      const manifestPath = join(dir, "2026-06-14", "20-42-00-000Z", "prune-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.deleted).toEqual([]);
      expect(manifest.failed[0].paths).toEqual(["votes/v1/2026-06-14/old.json"]);
      expect(manifest.failed[0].error).toMatch(/PRUNE_SECRET/);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = originalToken;
      if (originalSecret !== undefined) process.env.PRUNE_SECRET = originalSecret;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("selects only old raw vote blobs for completed-hour pruning", () => {
    const candidates = pruneCandidatesForCompletedHour(
      [
        { vote: vote("old", "2026-06-14T19:59:59.000Z"), pathname: "votes/v1/2026-06-14/old.json" },
        { vote: vote("current", "2026-06-14T20:00:01.000Z"), pathname: "votes/v1/2026-06-14/current.json" },
        { vote: vote("summary", "2026-06-14T19:00:00.000Z"), pathname: "derived/v1/stats-summary.json" },
      ],
      new Date("2026-06-14T20:42:00.000Z"),
    );
    expect(candidates.map((row) => row.vote.id)).toEqual(["old"]);
  });

  it("refuses pruning when candidates are not verified locally", () => {
    const candidates = [{ vote: vote("old"), pathname: "votes/v1/2026-06-14/old.json" }];
    expect(verifyPruneSafety({ candidates, snapshotVotes: [], dailyVotes: [vote("old")] }).ok).toBe(false);
    expect(verifyPruneSafety({ candidates, snapshotVotes: [vote("old")], dailyVotes: [] }).ok).toBe(false);
    expect(verifyPruneSafety({ candidates, snapshotVotes: [vote("old")], dailyVotes: [vote("old")] }).ok).toBe(true);
  });
});
