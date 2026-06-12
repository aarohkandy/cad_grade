import { describe, expect, it } from "vitest";
import { pairKey, selectBattlePair } from "../src/server/pairs";
import type { ArenaItem } from "../src/shared/types";

function item(id: string): ArenaItem {
  return {
    id,
    family: "wall_planter",
    familyLabel: "Wall planter",
    active: true,
    title: id,
    seedId: id,
    prompt: "prompt",
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
});
