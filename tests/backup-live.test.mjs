import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
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
    globalThis.fetch = async (url, options) => {
      expect(String(url)).toBe("https://cadbattle.vercel.app/api/prune-votes");
      expect(options.method).toBe("POST");
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
