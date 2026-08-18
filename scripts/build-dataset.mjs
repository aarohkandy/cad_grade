import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readArgs } from "./analysis-core.mjs";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_SOURCE_ROOT = path.resolve(APP_ROOT, "..");
const MANIFEST_STAGING_SUFFIX = ".staging";

const SOURCES = [
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_smoke_reps2_manual/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_smoke_blind_extra/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_smoke_blind_20260608_reps3/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_hook_20260611_reps3/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_gapfill_20260612_reps3/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_gapfill2_20260613_reps3/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_gapfill3_20260614_reps3/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_gapfill_solidish_20260615_reps3/results.jsonl",
  "projects/cadybara-online-testing/workspace/runs/cadybara_online_snowman_20260609_reps4/results.jsonl",
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
  snowman: {
    family: "snowman",
    familyLabel: "Snowman",
    tags: ["snowman", "curved", "printable"],
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

function outputPaths(appRoot) {
  return {
    datasetRoot: path.join(appRoot, "public", "dataset", "v1"),
    publicData: path.join(appRoot, "public", "data", "items.json"),
    generatedJson: path.join(appRoot, "src", "data", "items.generated.json"),
    generatedTs: path.join(appRoot, "src", "data", "items.generated.ts"),
  };
}

export function missingSources(sourceRoot = DEFAULT_SOURCE_ROOT) {
  return SOURCES.filter((relativePath) => !existsSync(path.join(sourceRoot, relativePath)));
}

function missingArtifacts(sourceRoot, candidates) {
  return candidates
    .flatMap((candidate) => [candidate.stl, candidate.preview])
    .filter((relativePath) => !existsSync(path.join(sourceRoot, relativePath)));
}

function listPaths(paths, limit = 3) {
  const shown = paths.slice(0, limit).map((entry) => `  ${entry}`);
  if (paths.length > limit) shown.push(`  ...and ${paths.length - limit} more`);
  return shown;
}

export function sourcesUnavailableMessage(sourceRoot, missing) {
  return [
    `Cannot rebuild the dataset: ${missing.length} of ${SOURCES.length} source run files are missing under ${sourceRoot}`,
    ...listPaths(missing),
    "",
    "This generator reads the private Cadybara run tree, which is not part of this repo.",
    "What it produces is already built and committed under public/dataset/v1, so a fresh",
    "clone never needs to run it. `npm run check:dataset` verifies what is committed.",
    "",
    "If the run tree lives elsewhere, pass the directory that contains `projects/`:",
    "  npm run dataset -- --sources-root ../path/to/parent",
    "",
    "Nothing was changed.",
  ].join("\n");
}

function noUsableRowsMessage(sourceRoot) {
  return [
    `Cannot rebuild the dataset: the ${SOURCES.length} source run files under ${sourceRoot} contain no usable rows.`,
    "A row is usable when its seed id maps to a known family and it carries both an STL and a preview artifact.",
    "",
    "Nothing was changed.",
  ].join("\n");
}

function artifactsUnavailableMessage(sourceRoot, missing) {
  return [
    `Cannot rebuild the dataset: ${missing.length} artifacts referenced by the run files are missing under ${sourceRoot}`,
    ...listPaths(missing),
    "",
    "Nothing was changed.",
  ].join("\n");
}

async function readRows(sourceRoot, relativePath) {
  const lines = (await readFile(path.join(sourceRoot, relativePath), "utf8")).split(/\r?\n/);
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

async function latestRows(sourceRoot) {
  const latest = new Map();
  for (const relativePath of SOURCES) {
    const rows = await readRows(sourceRoot, relativePath);
    for (const row of rows) {
      latest.set(cellKey(row), { row, source: relativePath });
    }
  }
  return [...latest.values()];
}

// A killed rebuild leaves its staging directory and `.staging` manifests inside Vite's public
// root, where the next `vite build` would copy them into dist/.
async function clearStaleStaging(datasetRoot, manifestDestinations) {
  const parent = path.dirname(datasetRoot);
  const prefix = `${path.basename(datasetRoot)}-staging-`;
  for (const entry of await readdir(parent)) {
    if (entry.startsWith(prefix)) await rm(path.join(parent, entry), { recursive: true, force: true });
  }
  for (const destination of manifestDestinations) {
    await rm(`${destination}${MANIFEST_STAGING_SUFFIX}`, { force: true });
  }
}

async function copyArtifact(sourceRoot, sourceRelativePath, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(path.join(sourceRoot, sourceRelativePath), destinationPath);
}

function displayName(seedId, repetition) {
  const words = String(seedId)
    .replace(/^(planter|hook)_/, "")
    .replace(/^\d+_/, "")
    .replaceAll("_", " ");
  return `${words || "model"} ${Number(repetition) + 1}`;
}

/**
 * Resolves to null once the dataset has been rebuilt, or to a message explaining why it was not.
 * Every run file, the rows they yield, and every artifact those rows reference are checked before
 * anything on disk is touched, and the new copy is staged beside the old one and swapped in last,
 * so a refusal or a failed copy leaves what is committed alone. The swap itself is an rm followed
 * by a rename: a failure between the two leaves the rebuilt copy in its staging directory and the
 * old one already gone.
 */
export async function build({ sourceRoot = DEFAULT_SOURCE_ROOT, appRoot = APP_ROOT } = {}) {
  const missing = missingSources(sourceRoot);
  if (missing.length) return sourcesUnavailableMessage(sourceRoot, missing);

  const candidates = (await latestRows(sourceRoot))
    .map(({ row, source }) => {
      const artifacts = row.artifacts || {};
      const meta = familyForSeed(row.seed_id);
      const stl = artifacts.hosted_stl || artifacts.stl;
      const preview = artifacts.preview_png;
      if (!meta || !stl || !preview) return null;
      return { row, source, stl, preview, meta };
    })
    .filter(Boolean);

  if (!candidates.length) return noUsableRowsMessage(sourceRoot);

  const missingFiles = missingArtifacts(sourceRoot, candidates);
  if (missingFiles.length) return artifactsUnavailableMessage(sourceRoot, missingFiles);

  const paths = outputPaths(appRoot);
  const manifestDestinations = [paths.publicData, paths.generatedJson, paths.generatedTs];
  await mkdir(path.dirname(paths.datasetRoot), { recursive: true });
  await clearStaleStaging(paths.datasetRoot, manifestDestinations);
  const staging = await mkdtemp(`${paths.datasetRoot}-staging-`);
  const items = [];
  let datasetRemoved = false;

  try {
    for (const candidate of candidates) {
      const { row, source, stl, preview, meta } = candidate;
      const publicHash = hash(`${row.run_id}|${source}`);
      const id = `${meta.family}-${slug(row.seed_id)}-r${row.repetition}-${publicHash}`;
      const assetDir = path.join(staging, meta.family, id);
      await copyArtifact(sourceRoot, stl, path.join(assetDir, "model.stl"));
      await copyArtifact(sourceRoot, preview, path.join(assetDir, "preview.png"));

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

    const manifestJson = `${JSON.stringify(payload, null, 2)}\n`;
    const manifests = [
      [paths.publicData, manifestJson],
      [paths.generatedJson, manifestJson],
      [
        paths.generatedTs,
        [
          'import type { DatasetPayload } from "../shared/types";',
          "",
          `const dataset = ${JSON.stringify(payload, null, 2)} as unknown as DatasetPayload;`,
          "",
          "export default dataset;",
          "",
        ].join("\n"),
      ],
    ];

    for (const [destination, body] of manifests) {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(`${destination}${MANIFEST_STAGING_SUFFIX}`, body);
    }

    await rm(paths.datasetRoot, { recursive: true, force: true });
    datasetRemoved = true;
    await rename(staging, paths.datasetRoot);
    datasetRemoved = false;
    for (const [destination] of manifests) {
      await rename(`${destination}${MANIFEST_STAGING_SUFFIX}`, destination);
    }
  } catch (error) {
    // Once the old dataset has been removed the staged copy is the only one left, so deleting
    // it here would turn a failed rename into total loss. Say where it is instead.
    if (datasetRemoved) {
      console.error(
        `The dataset swap failed after the old copy was removed. The rebuilt dataset is at ${staging}; move it to ${paths.datasetRoot} to finish, or re-run this script.`,
      );
    } else {
      await rm(staging, { recursive: true, force: true });
    }
    for (const destination of manifestDestinations) {
      await rm(`${destination}${MANIFEST_STAGING_SUFFIX}`, { force: true });
    }
    throw error;
  }

  const byFamily = items.reduce((counts, item) => {
    counts[item.family] = (counts[item.family] || 0) + 1;
    return counts;
  }, {});
  console.log(`Wrote ${items.length} items`);
  console.log(JSON.stringify(byFamily, null, 2));
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = readArgs(process.argv.slice(2));
  const requestedRoot = args["sources-root"];
  if (requestedRoot === "true") {
    console.error("--sources-root needs a directory, for example: npm run dataset -- --sources-root ../cadybara");
    process.exit(1);
  }
  const sourceRoot = path.resolve(requestedRoot || DEFAULT_SOURCE_ROOT);
  build({ sourceRoot })
    .then((problem) => {
      if (!problem) return;
      console.error(problem);
      process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
