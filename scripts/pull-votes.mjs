import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  if (/^https?:\/\//.test(value)) return value;
  return `https://${value}`;
}

const args = readArgs(process.argv.slice(2));
const baseUrl = deploymentUrl(args.url || process.env.CAPYBARA_ARENA_URL || process.env.VERCEL_URL);

if (!baseUrl) {
  console.error("Usage: node scripts/pull-votes.mjs --url https://your-app.vercel.app [--date YYYY-MM-DD] [--out exports/votes.jsonl]");
  process.exit(1);
}

const endpoint = new URL("/api/export", baseUrl);
endpoint.searchParams.set("format", "json");
if (args.date) endpoint.searchParams.set("date", args.date);
if (args.limit) endpoint.searchParams.set("limit", args.limit);

const response = await fetch(endpoint);

if (!response.ok) {
  const body = await response.text();
  throw new Error(`Export failed with ${response.status}: ${body}`);
}

const payload = await response.json();
const suffix = args.date || new Date().toISOString().slice(0, 10);
const outPath = args.out || join("exports", `votes-${suffix}.jsonl`);
const votes = Array.isArray(payload.votes) ? payload.votes : [];
const jsonl = votes.map((vote) => JSON.stringify(vote)).join("\n") + (votes.length ? "\n" : "");

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, jsonl, "utf8");

console.log(`Wrote ${votes.length} votes to ${outPath}`);
