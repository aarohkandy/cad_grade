import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const DATA_PATH = path.join(APP_ROOT, "src", "data", "items.generated.json");

function fail(message) {
  throw new Error(message);
}

async function main() {
  const payload = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const ids = new Set();
  if (payload.itemCount !== 94) fail(`Expected 94 items, found ${payload.itemCount}`);
  for (const item of payload.items) {
    if (ids.has(item.id)) fail(`Duplicate item id: ${item.id}`);
    ids.add(item.id);
    if (!item.active) fail(`Inactive item in launch dataset: ${item.id}`);
    if (!["wall_planter", "wall_hook", "snowman"].includes(item.family)) {
      fail(`Unexpected family for ${item.id}: ${item.family}`);
    }
    for (const key of ["stlUrl", "previewUrl"]) {
      const publicPath = path.join(APP_ROOT, "public", item[key].replace(/^\//, ""));
      const info = await stat(publicPath);
      if (!info.isFile() || info.size <= 0) fail(`Bad ${key} for ${item.id}`);
    }
  }
  const families = payload.items.reduce((counts, item) => {
    counts[item.family] = (counts[item.family] || 0) + 1;
    return counts;
  }, {});
  if (families.wall_planter !== 30) fail(`Expected 30 wall planters, found ${families.wall_planter}`);
  if (families.wall_hook !== 31) fail(`Expected 31 wall hooks, found ${families.wall_hook}`);
  if (families.snowman !== 33) fail(`Expected 33 snowmen, found ${families.snowman}`);
  console.log(`Dataset OK: ${payload.itemCount} items`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
