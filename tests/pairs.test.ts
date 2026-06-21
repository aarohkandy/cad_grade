import { describe, expect, it } from "vitest";
import { pairGroup, pairKey, selectBattleFamily, selectBattlePair, type ItemStatLike, type PairStatLike } from "../src/server/pairs";
import type { ArenaFamily, ArenaItem } from "../src/shared/types";

function item(id: string, family: ArenaFamily = "wall_planter"): ArenaItem {
  return {
    id,
    family,
    familyLabel: family === "wall_planter" ? "Wall planter" : family === "wall_hook" ? "Wall hook" : "Snowman",
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

describe("pair selection", () => {
  it("normalizes pair keys", () => {
    expect(pairKey("b", "a")).toBe("a__b");
  });

  it("marks cross-family pairs as mixed", () => {
    expect(pairGroup(item("snow", "snowman"), item("hook", "wall_hook"))).toBe("mixed");
    expect(pairGroup(item("a", "snowman"), item("b", "snowman"))).toBe("snowman");
  });

  it("selects global any-vs-any candidates", () => {
    const items = [item("planter-a"), item("hook-a", "wall_hook"), item("snowman-a", "snowman")];
    const selected = selectBattlePair({
      items,
      random: () => 0,
    });
    expect(new Set(selected.map((entry) => entry.family))).toEqual(new Set(["wall_planter", "wall_hook"]));
  });

  it("avoids already-voted pairs when possible", () => {
    const items = [item("a"), item("b"), item("c")];
    const selected = selectBattlePair({
      items,
      votedPairKeys: new Set([pairKey("a", "b"), pairKey("a", "c")]),
      random: () => 0,
    });
    expect(new Set(selected.map((entry) => entry.id))).toEqual(new Set(["b", "c"]));
  });

  it("prioritizes under-sampled items", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const itemStats = new Map<string, ItemStatLike>([
      ["a", { item_id: "a", battle_count: 12 }],
      ["b", { item_id: "b", battle_count: 12 }],
      ["c", { item_id: "c", battle_count: 0 }],
      ["d", { item_id: "d", battle_count: 0 }],
    ]);
    const selected = selectBattlePair({
      items,
      itemStats,
      random: () => 0,
    });
    expect(new Set(selected.map((entry) => entry.id))).toEqual(new Set(["c", "d"]));
  });

  it("prefers closer Elo matchups once items have signal", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const itemStats = new Map<string, ItemStatLike>([
      ["a", { item_id: "a", battle_count: 10, elo: 1200 }],
      ["b", { item_id: "b", battle_count: 10, elo: 1210 }],
      ["c", { item_id: "c", battle_count: 10, elo: 1500 }],
      ["d", { item_id: "d", battle_count: 10, elo: 900 }],
    ]);
    const selected = selectBattlePair({
      items,
      itemStats,
      random: () => 0,
    });
    expect(new Set(selected.map((entry) => entry.id))).toEqual(new Set(["a", "b"]));
  });

  it("penalizes repeated pairs", () => {
    const items = [item("a"), item("b"), item("c")];
    const pairStats = new Map<string, PairStatLike>([
      [pairKey("a", "b"), { pair_key: pairKey("a", "b"), family: "wall_planter", battle_count: 8 }],
    ]);
    const selected = selectBattlePair({
      items,
      pairStats,
      random: () => 0,
    });
    expect(new Set(selected.map((entry) => entry.id))).not.toEqual(new Set(["a", "b"]));
  });

  it("balances family selection by category vote exposure", () => {
    const items = [
      item("planter-a"),
      item("planter-b"),
      item("hook-a", "wall_hook"),
      item("hook-b", "wall_hook"),
      item("snowman-a", "snowman"),
      item("snowman-b", "snowman"),
    ];
    const pairStats = new Map<string, PairStatLike>([
      [pairKey("planter-a", "planter-b"), { pair_key: pairKey("planter-a", "planter-b"), family: "wall_planter", battle_count: 8 }],
      [pairKey("hook-a", "hook-b"), { pair_key: pairKey("hook-a", "hook-b"), family: "wall_hook", battle_count: 7 }],
    ]);
    expect(
      selectBattleFamily({
        items,
        families: ["wall_planter", "wall_hook", "snowman"],
        pairStats,
        random: () => 0,
      }),
    ).toBe("snowman");
  });
});
