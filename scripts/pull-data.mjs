import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TABLES = ["votes", "item_stats", "pair_stats", "quality_flags"];

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function deploymentUrl(value) {
  if (!value) return "";
  if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, "");
  return `https://${value.replace(/\/+$/, "")}`;
}

function timestampSlug() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} failed with ${response.status}: ${text}`);
  return text;
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  return text ? JSON.parse(text) : null;
}

function apiUrl(baseUrl, pathname, params = {}) {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pullOnce({ baseUrl, token, date, limit, outDir }) {
  await mkdir(outDir, { recursive: true });
  const adminHeaders = { "x-admin-token": token };

  const health = await fetchJson(apiUrl(baseUrl, "/api/health"));
  const stats = await fetchJson(apiUrl(baseUrl, "/api/stats"));
  const exportJson = await fetchJson(
    apiUrl(baseUrl, "/api/export", {
      format: "json",
      date,
      limit,
    }),
    { headers: adminHeaders },
  );

  await writeJson(join(outDir, "health.json"), health);
  await writeJson(join(outDir, "stats.json"), stats);
  await writeJson(join(outDir, "export.json"), exportJson);

  const votes = Array.isArray(exportJson?.votes) ? exportJson.votes : [];
  const jsonl = votes.map((vote) => JSON.stringify(vote)).join("\n") + (votes.length ? "\n" : "");
  await writeFile(join(outDir, "votes.jsonl"), jsonl, "utf8");

  for (const table of TABLES) {
    const csv = await fetchText(
      apiUrl(baseUrl, "/api/export", {
        format: "csv",
        table,
        date,
        limit,
      }),
      { headers: adminHeaders },
    );
    await writeFile(join(outDir, `${table}.csv`), csv, "utf8");
  }

  const summary = [
    `url=${baseUrl}`,
    `pulled_at=${new Date().toISOString()}`,
    `health_ready=${health?.ready}`,
    `storage=${health?.storage}`,
    `storage_mode=${health?.storageMode}`,
    `total_votes=${stats?.totalVotes}`,
    `accepted_votes=${stats?.acceptedVotes}`,
    `exported_votes=${exportJson?.voteCount}`,
    `out=${outDir}`,
  ].join("\n");
  await writeFile(join(outDir, "summary.txt"), `${summary}\n`, "utf8");

  console.log(summary);
  return { health, stats, exportJson, outDir };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = readArgs(process.argv.slice(2));
const baseUrl = deploymentUrl(args.url || process.env.CAPYBARA_ARENA_URL || process.env.VERCEL_URL);
const token = args.token || process.env.ADMIN_EXPORT_TOKEN;

if (!baseUrl || !token) {
  console.error(
    "Usage: ADMIN_EXPORT_TOKEN=... npm run pull:data -- --url https://your-app.vercel.app [--date YYYY-MM-DD] [--limit 10000] [--out exports/live] [--watch 30]",
  );
  process.exit(1);
}

const date = args.date;
const limit = args.limit || 10_000;
const baseOut = args.out || join("exports", timestampSlug());
const watchSeconds = args.watch === "true" ? 30 : Number(args.watch || 0);

if (watchSeconds > 0) {
  console.log(`Watching ${baseUrl}; pulling every ${watchSeconds}s. Press Ctrl+C to stop.`);
  while (true) {
    const outDir = join(baseOut, timestampSlug());
    try {
      await pullOnce({ baseUrl, token, date, limit, outDir });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    await sleep(watchSeconds * 1000);
  }
} else {
  await pullOnce({ baseUrl, token, date, limit, outDir: baseOut });
}
