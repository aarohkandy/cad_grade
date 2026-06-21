import { chromium } from "@playwright/test";
import { join } from "node:path";
import { backupLive } from "./backup-live.mjs";
import { readArgs } from "./analysis-core.mjs";

function deploymentUrl(value) {
  if (!value) return "";
  if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, "");
  return `https://${value.replace(/\/+$/, "")}`;
}

const args = readArgs(process.argv.slice(2));
const baseUrl = deploymentUrl(args.url || process.env.CAPYBARA_ARENA_URL || "https://cadbattle.vercel.app");
const outRoot = args.out || join("exports", "live-backups");
const sessionId = `production-browser-check-${Date.now()}`;

const browser = await chromium.launch({ headless: true });
let voteResponseBody = null;

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 920 } });
  await page.addInitScript((session) => {
    window.localStorage.setItem("capybara-arena-session", session);
    window.localStorage.setItem("capybara-arena-seen-pairs", "[]");
    window.localStorage.setItem("capybara-arena-vote-history", "[]");
  }, sessionId);

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator("#arena").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !document.querySelector("#vote-left")?.disabled, null, { timeout: 45_000 });
  await page.waitForTimeout(1700);

  const voteResponsePromise = page.waitForResponse((response) => response.url().includes("/api/vote") && response.request().method() === "POST", {
    timeout: 45_000,
  });
  await page.locator("#vote-left").click();
  const voteResponse = await voteResponsePromise;
  voteResponseBody = await voteResponse.json();
  if (!voteResponse.ok() || voteResponseBody?.saved !== true) {
    throw new Error(`Live vote failed: ${voteResponse.status()} ${JSON.stringify(voteResponseBody)}`);
  }

  await page.locator("#feedback-panel:not(.is-hidden)").waitFor({ timeout: 20_000 });
  const feedback = await page.locator("#feedback-title").textContent();
  if (!String(feedback || "").toLowerCase().includes("saved")) {
    throw new Error(`Unexpected feedback title: ${feedback}`);
  }
  await page.locator("#vote-left:not([disabled])").waitFor({ timeout: 20_000 });
} finally {
  await browser.close();
}

const backup = await backupLive({
  baseUrl,
  outRoot,
  prune: "none",
  dryRunPrune: true,
  shouldProcess: true,
});

const found = backup.dailyVotes.some((vote) => vote.session_id === sessionId);
const excluded = backup.processing?.analysis?.excludedTestVoteIds?.some((id) => {
  const vote = backup.dailyVotes.find((candidate) => candidate.id === id);
  return vote?.session_id === sessionId;
});

if (!found) {
  throw new Error(`Tagged browser vote was not found in local backup: ${sessionId}`);
}
if (!excluded) {
  throw new Error(`Tagged browser vote was not excluded from default analysis: ${sessionId}`);
}

console.log(`session_id=${sessionId}`);
console.log(`vote_saved=${voteResponseBody?.saved}`);
console.log(`snapshot=${backup.snapshotDir}`);
console.log(`analysis=${backup.processing.latestDir}`);
console.log("browser_vote_pull_check=ok");
