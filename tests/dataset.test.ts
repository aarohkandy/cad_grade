import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import dataset from "../src/data/items.generated.json";

const appRoot = path.resolve(import.meta.dirname, "..");

describe("dataset", () => {
  it("contains the launch set", () => {
    expect(dataset.itemCount).toBe(40);
    expect(dataset.items.filter((item) => item.family === "wall_planter")).toHaveLength(30);
    expect(dataset.items.filter((item) => item.family === "wall_hook")).toHaveLength(10);
  });

  it("has unique ids and existing public assets", () => {
    const ids = new Set<string>();
    for (const item of dataset.items) {
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
      expect(existsSync(path.join(appRoot, "public", item.stlUrl.replace(/^\//, "")))).toBe(true);
      expect(existsSync(path.join(appRoot, "public", item.previewUrl.replace(/^\//, "")))).toBe(true);
    }
  });
});
