import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

// The swap is an rm followed by a rename. Only a failing rename can exercise what happens in
// that window, and it cannot be provoked with real filesystem calls, so rename is wrapped.
let failRenameTo = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: async (from, to) => {
      if (failRenameTo && to === failRenameTo) throw new Error(`EPERM: operation not permitted, rename '${from}'`);
      return actual.rename(from, to);
    },
  };
});

import { build, missingSources, sourcesUnavailableMessage } from "../scripts/build-dataset.mjs";

// build() rewrites the app root it is handed, so every test here passes a temp directory.
// With the default it would rebuild the repo's own public/dataset/v1.

function row(seedId) {
  return {
    run_id: `run-${seedId}`,
    experiment_id: "test-experiment",
    model_name: "test-model",
    provider: "test",
    seed_id: seedId,
    condition_name: "base",
    sampling: {},
    repetition: 0,
    latency_ms: 900,
    provider_metadata: { validation: { valid: true } },
    artifacts: {
      hosted_stl: `artifacts/${seedId}/model.stl`,
      preview_png: `artifacts/${seedId}/preview.png`,
    },
  };
}

async function writeFileAt(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

// missingSources() on an empty root reports exactly the run files the generator wants, so the
// fixture builds those rather than repeating the list.
async function writeSourceTree(root, rows, { skipArtifactsFor } = {}) {
  for (const relativePath of missingSources(root)) {
    await writeFileAt(join(root, relativePath), `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
  for (const entry of rows) {
    if (entry.seed_id === skipArtifactsFor) continue;
    await writeFileAt(join(root, entry.artifacts.hosted_stl), `solid ${entry.seed_id}\nendsolid\n`);
    await writeFileAt(join(root, entry.artifacts.preview_png), `png ${entry.seed_id}\n`);
  }
}

async function appWithCommittedDataset(appRoot) {
  const committed = join(appRoot, "public", "dataset", "v1", "wall_hook", "committed", "model.stl");
  await writeFileAt(committed, "committed asset\n");
  return committed;
}

describe("dataset generator", () => {
  it("reports every missing run file without touching the source tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "cad-sources-"));
    try {
      const missing = missingSources(root);
      expect(missing.length).toBeGreaterThan(0);
      expect(missing.every((relativePath) => relativePath.endsWith("results.jsonl"))).toBe(true);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("explains where the dataset already lives and how to point at the run tree", () => {
    const message = sourcesUnavailableMessage("/nowhere", missingSources("/nowhere"));
    expect(message).toContain("public/dataset/v1");
    expect(message).toContain("--sources-root");
    expect(message).toContain("Nothing was changed.");
  });

  it("refuses to rebuild without sources and leaves the committed dataset alone", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "cad-app-"));
    try {
      const committed = await appWithCommittedDataset(appRoot);
      const problem = await build({ sourceRoot: join(appRoot, "no-run-tree"), appRoot });
      expect(problem).toContain("Cannot rebuild the dataset");
      expect(existsSync(committed)).toBe(true);
      expect(await readdir(join(appRoot, "public", "dataset"))).toEqual(["v1"]);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });

  it("refuses when a run file points at an artifact that is not there", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "cad-app-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "cad-sources-"));
    try {
      const committed = await appWithCommittedDataset(appRoot);
      await writeSourceTree(sourceRoot, [row("planter_3_wall_box"), row("hook_5_j_curve")], {
        skipArtifactsFor: "hook_5_j_curve",
      });
      const problem = await build({ sourceRoot, appRoot });
      expect(problem).toContain("artifacts");
      expect(problem).toContain("hook_5_j_curve");
      expect(existsSync(committed)).toBe(true);
      expect(await readdir(join(appRoot, "public", "dataset"))).toEqual(["v1"]);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("refuses when every run file is present but yields no usable row", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "cad-app-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "cad-sources-"));
    try {
      const committed = await appWithCommittedDataset(appRoot);
      await writeSourceTree(sourceRoot, []);
      expect(missingSources(sourceRoot)).toEqual([]);

      const problem = await build({ sourceRoot, appRoot });
      expect(problem).toContain("no usable rows");
      expect(existsSync(committed)).toBe(true);
      expect(existsSync(join(appRoot, "public", "data", "items.json"))).toBe(false);
      expect(await readdir(join(appRoot, "public", "dataset"))).toEqual(["v1"]);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("swaps in the new dataset once every asset has copied", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "cad-app-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "cad-sources-"));
    try {
      const committed = await appWithCommittedDataset(appRoot);
      await writeSourceTree(sourceRoot, [row("planter_3_wall_box"), row("hook_5_j_curve"), row("snowman_2_stack")]);

      expect(await build({ sourceRoot, appRoot })).toBeNull();

      const payload = JSON.parse(await readFile(join(appRoot, "src", "data", "items.generated.json"), "utf8"));
      expect(payload.itemCount).toBe(3);
      expect([...payload.families].sort()).toEqual(["snowman", "wall_hook", "wall_planter"]);
      for (const item of payload.items) {
        expect(existsSync(join(appRoot, "public", item.stlUrl.replace(/^\//, "")))).toBe(true);
        expect(existsSync(join(appRoot, "public", item.previewUrl.replace(/^\//, "")))).toBe(true);
      }
      expect(existsSync(committed)).toBe(false);
      expect(await readdir(join(appRoot, "public", "dataset"))).toEqual(["v1"]);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("clears staging left behind by a killed rebuild", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "cad-app-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "cad-sources-"));
    try {
      await appWithCommittedDataset(appRoot);
      await writeFileAt(join(appRoot, "public", "dataset", "v1-staging-aBc123", "half.stl"), "half copied\n");
      await writeFileAt(join(appRoot, "public", "data", "items.json.staging"), "{}\n");
      await writeSourceTree(sourceRoot, [row("planter_3_wall_box")]);

      expect(await build({ sourceRoot, appRoot })).toBeNull();

      expect(await readdir(join(appRoot, "public", "dataset"))).toEqual(["v1"]);
      expect(await readdir(join(appRoot, "public", "data"))).toEqual(["items.json"]);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("keeps the rebuilt copy when the swap fails with the old dataset already gone", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "cad-app-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "cad-sources-"));
    const datasetRoot = join(appRoot, "public", "dataset", "v1");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    failRenameTo = datasetRoot;
    try {
      await appWithCommittedDataset(appRoot);
      await writeSourceTree(sourceRoot, [row("planter_3_wall_box"), row("hook_5_j_curve")]);

      await expect(build({ sourceRoot, appRoot })).rejects.toThrow(/EPERM/);

      // The committed copy is unrecoverable at this point, so the staged rebuild is the only
      // dataset left. Deleting it in the catch is what turned this into total loss.
      const remaining = await readdir(join(appRoot, "public", "dataset"));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatch(/^v1-staging-/);
      expect(existsSync(join(appRoot, "public", "dataset", remaining[0], "wall_planter"))).toBe(true);
      expect(logged.mock.calls.flat().join(" ")).toContain(remaining[0]);
    } finally {
      failRenameTo = null;
      logged.mockRestore();
      await rm(appRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});
