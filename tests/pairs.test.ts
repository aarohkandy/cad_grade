import { describe, expect, it } from "vitest";
import {
  familyComboKey,
  pairGroup,
  pairKey,
  selectBattleFamily,
  selectBattlePair,
  type ItemStatLike,
  type PairStatLike,
} from "../src/server/pairs";
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
    expect(new Set(selected.map((entry) => entry.id)).size).toBe(2);
    expect(new Set(selected.map((entry) => entry.family)).size).toBeGreaterThan(1);
  });

  it("rotates global selection across category matchups within a session", () => {
    const items = [
      item("planter-a"),
      item("planter-b"),
      item("hook-a", "wall_hook"),
      item("hook-b", "wall_hook"),
      item("snowman-a", "snowman"),
      item("snowman-b", "snowman"),
    ];
    const votedPairKeys = new Set<string>();
    const seenCombos = new Set<string>();

    for (let index = 0; index < 6; index += 1) {
      const selected = selectBattlePair({
        items,
        votedPairKeys,
        random: () => 0,
      });
      votedPairKeys.add(pairKey(selected[0].id, selected[1].id));
      seenCombos.add(familyComboKey(selected[0].family, selected[1].family));
    }

    expect(seenCombos).toEqual(
      new Set([
        "wall_planter__wall_planter",
        "wall_hook__wall_planter",
        "snowman__wall_planter",
        "wall_hook__wall_hook",
        "snowman__wall_hook",
        "snowman__snowman",
      ]),
    );
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

  it("avoids overused session items when possible", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const selected = selectBattlePair({
      items,
      votedPairKeys: new Set([pairKey("a", "b")]),
      random: () => 0,
    });
    expect(new Set(selected.map((entry) => entry.id))).toEqual(new Set(["c", "d"]));
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

  it("occasionally explores the wider candidate pool", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const itemStats = new Map<string, ItemStatLike>([
      ["a", { item_id: "a", battle_count: 12 }],
      ["b", { item_id: "b", battle_count: 12 }],
      ["c", { item_id: "c", battle_count: 0 }],
      ["d", { item_id: "d", battle_count: 0 }],
    ]);
    const randomValues = [0.99, 0, 0.99];
    const selected = selectBattlePair({
      items,
      itemStats,
      random: () => randomValues.shift() ?? 0,
    });
    expect(new Set(selected.map((entry) => entry.id))).toEqual(new Set(["a", "b"]));
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

  it("prioritizes under-sampled category matchups globally", () => {
    const items = [
      item("planter-a"),
      item("planter-b"),
      item("hook-a", "wall_hook"),
      item("hook-b", "wall_hook"),
      item("snowman-a", "snowman"),
      item("snowman-b", "snowman"),
    ];
    const pairStats = new Map<string, PairStatLike>([
      [
        pairKey("planter-a", "planter-b"),
        { pair_key: pairKey("planter-a", "planter-b"), family: "wall_planter", battle_count: 8 },
      ],
      [
        pairKey("planter-a", "hook-a"),
        {
          pair_key: pairKey("planter-a", "hook-a"),
          family: "mixed",
          item_a_family: "wall_planter",
          item_b_family: "wall_hook",
          battle_count: 8,
        },
      ],
      [
        pairKey("planter-a", "snowman-a"),
        {
          pair_key: pairKey("planter-a", "snowman-a"),
          family: "mixed",
          item_a_family: "wall_planter",
          item_b_family: "snowman",
          battle_count: 8,
        },
      ],
      [pairKey("hook-a", "hook-b"), { pair_key: pairKey("hook-a", "hook-b"), family: "wall_hook", battle_count: 8 }],
      [
        pairKey("snowman-a", "snowman-b"),
        { pair_key: pairKey("snowman-a", "snowman-b"), family: "snowman", battle_count: 8 },
      ],
    ]);
    const selected = selectBattlePair({
      items,
      pairStats,
      random: () => 0,
    });

    expect(familyComboKey(selected[0].family, selected[1].family)).toBe("snowman__wall_hook");
  });

  it("rotates away from a category matchup already seen in the session", () => {
    const items = [
      item("planter-a"),
      item("planter-b"),
      item("hook-a", "wall_hook"),
      item("hook-b", "wall_hook"),
      item("snowman-a", "snowman"),
      item("snowman-b", "snowman"),
    ];
    const pairStats = new Map<string, PairStatLike>([
      [
        pairKey("planter-a", "planter-b"),
        { pair_key: pairKey("planter-a", "planter-b"), family: "wall_planter", battle_count: 40 },
      ],
      [
        pairKey("planter-a", "hook-a"),
        {
          pair_key: pairKey("planter-a", "hook-a"),
          family: "mixed",
          item_a_family: "wall_planter",
          item_b_family: "wall_hook",
          battle_count: 40,
        },
      ],
      [
        pairKey("planter-a", "snowman-a"),
        {
          pair_key: pairKey("planter-a", "snowman-a"),
          family: "mixed",
          item_a_family: "wall_planter",
          item_b_family: "snowman",
          battle_count: 40,
        },
      ],
      [pairKey("hook-a", "hook-b"), { pair_key: pairKey("hook-a", "hook-b"), family: "wall_hook", battle_count: 1 }],
      [
        pairKey("snowman-a", "hook-a"),
        {
          pair_key: pairKey("snowman-a", "hook-a"),
          family: "mixed",
          item_a_family: "snowman",
          item_b_family: "wall_hook",
          battle_count: 40,
        },
      ],
      [
        pairKey("snowman-a", "snowman-b"),
        { pair_key: pairKey("snowman-a", "snowman-b"), family: "snowman", battle_count: 40 },
      ],
    ]);
    const selected = selectBattlePair({
      items,
      pairStats,
      votedPairKeys: new Set([pairKey("hook-a", "hook-b")]),
      random: () => 0,
    });

    expect(familyComboKey(selected[0].family, selected[1].family)).not.toBe("wall_hook__wall_hook");
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
      [
        pairKey("planter-a", "planter-b"),
        { pair_key: pairKey("planter-a", "planter-b"), family: "wall_planter", battle_count: 8 },
      ],
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
