import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { analyzeVotes, processData, writeAnalysisOutputs } from "../scripts/analysis-core.mjs";

function item(id, family = "wall_planter") {
  return {
    id,
    family,
    familyLabel: family === "wall_hook" ? "Wall hook" : "Wall planter",
    active: true,
    title: id,
    seedId: id,
    specificityLevel: 1,
    repetition: 0,
    experimentId: "exp",
    modelName: "model",
    provider: "provider",
    latencyMs: 100,
    validation: null,
    tags: [],
    stlUrl: "/model.stl",
    previewUrl: "/preview.png",
    sourceHash: id,
  };
}

function dataset() {
  return {
    datasetId: "test-dataset",
    generatedAtUtc: "2026-06-14T00:00:00.000Z",
    itemCount: 4,
    families: ["wall_planter", "wall_hook"],
    items: [item("a"), item("b"), item("c"), item("h1", "wall_hook")],
  };
}

function vote(overrides = {}) {
  const winner = overrides.winner_item_id === undefined ? "a" : overrides.winner_item_id;
  const left = overrides.left_item_id || "a";
  const right = overrides.right_item_id || "b";
  const isDraw = overrides.vote_result === "draw" || winner === null;
  return {
    id: overrides.id || `vote-${Math.random()}`,
    created_at: overrides.created_at || "2026-06-14T12:00:00.000Z",
    dataset_id: "test-dataset",
    battle_id: "battle",
    family: overrides.family || "wall_planter",
    left_item_id: left,
    right_item_id: right,
    winner_item_id: isDraw ? null : winner,
    loser_item_id: isDraw ? null : winner === left ? right : left,
    vote_result: isDraw ? "draw" : "winner",
    session_id: overrides.session_id || "session-human-123456",
    started_at: "2026-06-14T11:59:55.000Z",
    models_loaded_at: "2026-06-14T11:59:56.000Z",
    voted_at: "2026-06-14T12:00:00.000Z",
    elapsed_ms: overrides.elapsed_ms ?? 5000,
    load_ms: 1000,
    hold_duration_ms: null,
    hold_target_ms: null,
    hold_passed: false,
    duplicate_pair: overrides.duplicate_pair || false,
    too_fast: overrides.too_fast || false,
    accepted_for_scoring: overrides.accepted_for_scoring ?? true,
    quality_flags: overrides.quality_flags || [],
    ip_hash: "ip",
    user_agent_hash: "ua",
    raw_payload: {},
    storage: {
      mode: "blob",
      path: `votes/v1/2026-06-14/${overrides.id || "vote"}.json`,
    },
    ...overrides,
  };
}

describe("local analysis core", () => {
  it("separates raw, clean, and excluded production test votes", () => {
    const analysis = analyzeVotes({
      dataset: dataset(),
      votes: [
        vote({ id: "clean" }),
        vote({
          id: "fast",
          session_id: "fast-session",
          too_fast: true,
          accepted_for_scoring: false,
          quality_flags: ["too_fast", "hold_required"],
        }),
        vote({ id: "test", session_id: "production-browser-check-123" }),
      ],
      generatedAtUtc: "2026-06-14T12:10:00.000Z",
    });

    expect(analysis.totals.totalRawVotes).toBe(3);
    expect(analysis.totals.reportRawVotes).toBe(2);
    expect(analysis.totals.cleanVotes).toBe(1);
    expect(analysis.totals.excludedTestVotes).toBe(1);
    expect(analysis.excludedTestVoteIds).toEqual(["test"]);
    expect(analysis.rankingsRaw.find((row) => row.item_id === "a").battles).toBe(2);
    expect(analysis.rankingsClean.find((row) => row.item_id === "a").battles).toBe(1);
  });

  it("counts draw votes without moving Elo", () => {
    const analysis = analyzeVotes({
      dataset: dataset(),
      votes: [vote({ id: "draw", vote_result: "draw", winner_item_id: null })],
      generatedAtUtc: "2026-06-14T12:10:00.000Z",
    });

    const a = analysis.rankingsClean.find((row) => row.item_id === "a");
    const b = analysis.rankingsClean.find((row) => row.item_id === "b");
    expect(a.draws).toBe(1);
    expect(b.draws).toBe(1);
    expect(a.elo).toBe(1200);
    expect(b.elo).toBe(1200);
  });

  it("puts under-covered items and pairs first in coverage gaps", () => {
    const analysis = analyzeVotes({
      dataset: dataset(),
      votes: [vote({ id: "one", left_item_id: "a", right_item_id: "b", winner_item_id: "a" })],
      generatedAtUtc: "2026-06-14T12:10:00.000Z",
    });

    expect(analysis.coverageGaps[0]).toMatchObject({ gap_type: "item", target_id: "c", current_votes: 0 });
    expect(analysis.coverageGaps.some((row) => row.gap_type === "pair" && row.current_votes === 0)).toBe(true);
  });

  it("flags high-volume, too-fast, duplicate-heavy, and low-median sessions", () => {
    const votes = Array.from({ length: 30 }, (_, index) =>
      vote({
        id: `burst-${index}`,
        session_id: "burst-session",
        created_at: `2026-06-14T12:${String(index).padStart(2, "0")}:00.000Z`,
        too_fast: index < 20,
        duplicate_pair: index < 15,
        elapsed_ms: 700,
        accepted_for_scoring: false,
        quality_flags: ["too_fast", "duplicate_pair"],
      }),
    );
    const analysis = analyzeVotes({ dataset: dataset(), votes });
    const types = new Set(analysis.anomalyRows.map((row) => row.anomaly_type));
    expect(types.has("high_volume_session")).toBe(true);
    expect(types.has("too_fast_session")).toBe(true);
    expect(types.has("duplicate_heavy_session")).toBe(true);
    expect(types.has("low_median_vote_time")).toBe(true);
  });

  it("handles 10,000 synthetic votes deterministically", () => {
    const ids = ["a", "b", "c"];
    const votes = Array.from({ length: 10_000 }, (_, index) => {
      const left = ids[index % ids.length];
      const right = ids[(index + 1) % ids.length];
      return vote({
        id: `scale-${index}`,
        left_item_id: left,
        right_item_id: right,
        winner_item_id: index % 7 === 0 ? right : left,
        session_id: `session-${index % 500}`,
        created_at: new Date(Date.UTC(2026, 5, 14, 0, 0, index)).toISOString(),
      });
    });
    const first = analyzeVotes({ dataset: dataset(), votes, generatedAtUtc: "2026-06-14T13:00:00.000Z" });
    const second = analyzeVotes({ dataset: dataset(), votes, generatedAtUtc: "2026-06-14T13:00:00.000Z" });
    expect(first.totals.reportRawVotes).toBe(10_000);
    expect(first.totals.activeSessions).toBe(500);
    expect(first.rankingsRaw.slice(0, 3)).toEqual(second.rankingsRaw.slice(0, 3));
  });

  it("writes dashboard and data files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cad-analysis-"));
    try {
      const analysis = analyzeVotes({ dataset: dataset(), votes: [vote({ id: "clean" })] });
      await writeAnalysisOutputs(analysis, dir);
      expect(await readFile(join(dir, "index.html"), "utf8")).toContain("CadBattle Local Analysis");
      expect(await readFile(join(dir, "rankings_clean.csv"), "utf8")).toContain("item_id");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
