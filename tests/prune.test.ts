import { describe, expect, it } from "vitest";
import { completedUtcHour, isPrunableRawVotePath, prunableRawVotePaths, votePathCreatedAt } from "../src/server/prune";

describe("raw vote pruning guards", () => {
  const now = new Date("2026-06-22T08:42:00.000Z");

  it("parses vote blob timestamps from storage paths", () => {
    expect(votePathCreatedAt("votes/v1/2026-06-22/2026-06-22T07-31-44-123Z_vote.json")?.toISOString()).toBe(
      "2026-06-22T07:31:44.123Z",
    );
  });

  it("allows only completed-hour raw vote blobs", () => {
    expect(completedUtcHour(now).toISOString()).toBe("2026-06-22T08:00:00.000Z");
    expect(isPrunableRawVotePath("votes/v1/2026-06-22/2026-06-22T07-59-59-000Z_vote.json", now)).toBe(true);
    expect(isPrunableRawVotePath("votes/v1/2026-06-22/2026-06-22T08-00-00-000Z_vote.json", now)).toBe(false);
    expect(isPrunableRawVotePath("derived/v1/stats-summary.json", now)).toBe(false);
    expect(isPrunableRawVotePath("session-pairs/v1/session/pair.json", now)).toBe(false);
  });

  it("dedupes and sorts prunable paths", () => {
    expect(
      prunableRawVotePaths(
        [
          "votes/v1/2026-06-22/2026-06-22T07-59-59-000Z_b.json",
          "votes/v1/2026-06-22/2026-06-22T07-59-59-000Z_a.json",
          "votes/v1/2026-06-22/2026-06-22T07-59-59-000Z_a.json",
          "votes/v1/2026-06-22/2026-06-22T08-01-00-000Z_current.json",
        ],
        now,
      ),
    ).toEqual([
      "votes/v1/2026-06-22/2026-06-22T07-59-59-000Z_a.json",
      "votes/v1/2026-06-22/2026-06-22T07-59-59-000Z_b.json",
    ]);
  });
});
