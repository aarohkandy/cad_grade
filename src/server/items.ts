import datasetJson from "../data/items.generated.js";
import type { ArenaFamily, ArenaItem, DatasetPayload } from "../shared/types";

export const dataset = datasetJson as DatasetPayload;

export const activeItems = dataset.items.filter((item) => item.active);

export const familyLabels: Record<ArenaFamily, string> = {
  wall_planter: "Wall planter",
  wall_hook: "Wall hook",
};

export function itemById(id: string): ArenaItem | undefined {
  return activeItems.find((item) => item.id === id);
}

export function itemsForFamily(family: ArenaFamily): ArenaItem[] {
  return activeItems.filter((item) => item.family === family);
}

export function normalizeFamily(value: unknown): ArenaFamily | "any" {
  if (value === "wall_planter" || value === "wall_hook") return value;
  return "any";
}

export function publicItem(item: ArenaItem): ArenaItem {
  return item;
}
