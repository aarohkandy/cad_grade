import { describe, expect, it } from "vitest";
import { pairKey, selectBattleFamily, selectBattlePair, type ItemStatLike, type PairStatLike } from "../src/server/pairs";
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
