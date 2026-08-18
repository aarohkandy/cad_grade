import datasetJson from "../data/items.generated.js";
import type { ArenaFamily, ArenaItem, DatasetPayload, PublicArenaItem } from "../shared/types";

export const dataset = datasetJson as DatasetPayload;

export const activeItems = dataset.items.filter((item) => item.active);

export const familyLabels: Record<ArenaFamily, string> = {
  wall_planter: "Wall planter",
  wall_hook: "Wall hook",
  snowman: "Snowman",
};

export function itemById(id: string): ArenaItem | undefined {
  return activeItems.find((item) => item.id === id);
}

export function itemsForFamily(family: ArenaFamily): ArenaItem[] {
  return activeItems.filter((item) => item.family === family);
}

export function normalizeFamily(value: unknown): ArenaFamily | "any" {
  if (value === "wall_planter" || value === "wall_hook" || value === "snowman") return value;
  return "any";
}

export function publicItem(item: ArenaItem): PublicArenaItem {
  return {
    id: item.id,
    family: item.family,
    familyLabel: item.familyLabel,
    title: item.title,
    stlUrl: item.stlUrl,
    previewUrl: item.previewUrl,
  };
}
