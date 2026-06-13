import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_ROOT = path.resolve(APP_ROOT, "..");
const DATASET_ROOT = path.join(APP_ROOT, "public", "dataset", "v1");
const PUBLIC_DATA_PATH = path.join(APP_ROOT, "public", "data", "items.json");
const SOURCE_DATA_PATH = path.join(APP_ROOT, "src", "data", "items.generated.json");

const SOURCES = [
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_smoke_reps2_manual/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_smoke_blind_extra/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_smoke_blind_20260608_reps3/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_hook_20260611_reps3/results.jsonl",
];

const FAMILY_META = {
  planter: {
    family: "wall_planter",
    familyLabel: "Wall planter",
    tags: ["planter", "wall mounted", "printable"],
  },
  hook: {
    family: "wall_hook",
    familyLabel: "Wall hook",
    tags: ["hook", "wall mounted", "printable"],
  },
};

function hash(value, length = 10) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function specificity(seedId) {
  const match = String(seedId).match(/_(\d+)_/);
  return match ? Number(match[1]) : null;
}

function familyForSeed(seedId) {
  const prefix = String(seedId).split("_")[0];
  return FAMILY_META[prefix] || null;
}

function cellKey(row) {
  return [
    row.experiment_id,
    row.model_name,
    row.seed_id,
    row.condition_name,
    JSON.stringify(row.sampling || {}),
    row.repetition,
  ].join("|");
}

async function readRows(relativePath) {
  const sourcePath = path.join(SOURCE_ROOT, relativePath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing source JSONL: ${relativePath}`);
  }
  const lines = (await readFile(sourcePath, "utf8")).split(/\r?\n/);
  return lines
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Bad JSON at ${relativePath}:${index + 1}: ${error.message}`);
      }
    });
}

async function latestRows() {
  const latest = new Map();
  for (const relativePath of SOURCES) {
    const rows = await readRows(relativePath);
    for (const row of rows) {
      latest.set(cellKey(row), { row, source: relativePath });
    }
  }
  return [...latest.values()];
}

async function copyPublicAsset(sourceRelativePath, destinationRelativePath) {
  const sourcePath = path.join(SOURCE_ROOT, sourceRelativePath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing artifact: ${sourceRelativePath}`);
  }
  const destinationPath = path.join(APP_ROOT, destinationRelativePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

function displayName(seedId, repetition) {
  const words = String(seedId)
    .replace(/^(planter|hook)_/, "")
    .replace(/^\d+_/, "")
    .replaceAll("_", " ");
  return `${words || "model"} ${Number(repetition) + 1}`;
}

async function build() {
  await rm(DATASET_ROOT, { recursive: true, force: true });
  await mkdir(DATASET_ROOT, { recursive: true });

  const candidates = (await latestRows())
    .map(({ row, source }) => {
      const artifacts = row.artifacts || {};
      const meta = familyForSeed(row.seed_id);
      const stl = artifacts.hosted_stl || artifacts.stl;
      const preview = artifacts.preview_png;
      if (!meta || !stl || !preview) return null;
      return { row, source, stl, preview, meta };
    })
    .filter(Boolean);

  const items = [];
  for (const candidate of candidates) {
    const { row, source, stl, preview, meta } = candidate;
    const publicHash = hash(`${row.run_id}|${source}`);
    const id = `${meta.family}-${slug(row.seed_id)}-r${row.repetition}-${publicHash}`;
    const assetDir = `public/dataset/v1/${meta.family}/${id}`;
    await copyPublicAsset(stl, `${assetDir}/model.stl`);
    await copyPublicAsset(preview, `${assetDir}/preview.png`);

    items.push({
      id,
      family: meta.family,
      familyLabel: meta.familyLabel,
      active: true,
      title: displayName(row.seed_id, row.repetition),
      seedId: row.seed_id,
      specificityLevel: specificity(row.seed_id),
      repetition: row.repetition,
      experimentId: row.experiment_id,
      modelName: row.model_name,
      provider: row.provider,
      latencyMs: row.latency_ms,
      validation: row.provider_metadata?.validation || null,
      tags: meta.tags,
      stlUrl: `/dataset/v1/${meta.family}/${id}/model.stl`,
      previewUrl: `/dataset/v1/${meta.family}/${id}/preview.png`,
      sourceHash: publicHash,
    });
  }

  items.sort((left, right) => {
    return (
      left.family.localeCompare(right.family) ||
      left.seedId.localeCompare(right.seedId) ||
      left.repetition - right.repetition ||
      left.id.localeCompare(right.id)
    );
  });

  const payload = {
    datasetId: "cadybara-hosted-renderable-v1",
    generatedAtUtc: new Date().toISOString(),
    itemCount: items.length,
    families: [...new Set(items.map((item) => item.family))],
    items,
  };

  await mkdir(path.dirname(PUBLIC_DATA_PATH), { recursive: true });
  await mkdir(path.dirname(SOURCE_DATA_PATH), { recursive: true });
  await writeFile(PUBLIC_DATA_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(SOURCE_DATA_PATH, `${JSON.stringify(payload, null, 2)}\n`);

  const byFamily = items.reduce((counts, item) => {
    counts[item.family] = (counts[item.family] || 0) + 1;
    return counts;
  }, {});
  console.log(`Wrote ${items.length} items`);
  console.log(JSON.stringify(byFamily, null, 2));
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
