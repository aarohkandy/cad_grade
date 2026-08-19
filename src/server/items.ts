import datasetJson from "../data/items.generated.js";
import type { ArenaFamily, ArenaItem, DatasetPayload, PublicArenaItem } from "../shared/types";

export const dataset = datasetJson as DatasetPayload;

export const activeItems = dataset.items.filter((item) => item.active);

export const familyLabels: Record<ArenaFamily, string> = {
  wall_planter: "Wall planter",
  wall_hook: "Wall hook",
  snowman: "Snowman",
};

// api/vote resolves three items per vote and /api/export four per stored record, so the
// lookup is indexed once here instead of rescanning activeItems on every call.
const itemsById = new Map(activeItems.map((item) => [item.id, item]));

export function itemById(id: string): ArenaItem | undefined {
  return itemsById.get(id);
}

export function itemsForFamily(family: ArenaFamily): ArenaItem[] {
  return activeItems.filter((item) => item.family === family);
}

export function normalizeFamily(value: unknown): ArenaFamily | "any" {
  if (typeof value === "string" && Object.hasOwn(familyLabels, value)) return value as ArenaFamily;
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
