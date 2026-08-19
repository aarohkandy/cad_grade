import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.SCREENSHOT_PORT || 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DIST_ENTRY = path.join(APP_ROOT, "dist", "index.html");
const OUT_PATH = path.join(APP_ROOT, "docs", "screenshot-arena.png");
// An empty vote store, so the header counter reads what a fresh clone reads instead of
// however many local test votes this machine has piled up in .local-data.
const CAPTURE_VOTE_DIR = path.join(APP_ROOT, "test-results", "screenshot-votes");
const VIEWPORT = { width: 1280, height: 800 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // Not listening yet, which is the normal state for the first second or so.
    }
    await sleep(250);
  }
  throw new Error(`Preview server did not start at ${BASE_URL}`);
}

async function assertPortFree() {
  try {
    await fetch(BASE_URL);
  } catch {
    return;
  }
  // Whatever is already on the port has its own vote store and possibly its own build,
  // and shooting that instead would be invisible in the resulting image.
  throw new Error(`Capture port is already in use: ${BASE_URL}`);
}

async function capture(browser) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // The vote buttons only enable after both STLs have parsed and both panels are titled.
  await page.locator("#vote-left:not([disabled])").waitFor({ timeout: 60_000 });
  // Enabled is not the same as drawn: three.js still owes the first few frames, and a
  // shot taken on the enabling tick catches a half-lit mesh.
  await sleep(1500);
  const pair = await page.evaluate(() => ({
    left: document.querySelector("#left-subtitle")?.textContent || "",
    right: document.querySelector("#right-subtitle")?.textContent || "",
  }));
  await page.screenshot({ path: OUT_PATH });
  await page.close();
  return pair;
}

if (!existsSync(DIST_ENTRY)) {
  console.error(`No build to capture at ${DIST_ENTRY}. Run \`npm run build\` first.`);
  process.exitCode = 1;
} else {
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await rm(CAPTURE_VOTE_DIR, { recursive: true, force: true });
  await assertPortFree();
  const server = spawn(
    process.execPath,
    ["./node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        LOCAL_VOTE_DIR: CAPTURE_VOTE_DIR,
        IP_HASH_SALT: process.env.IP_HASH_SALT || "screenshot-ip-salt",
        HOLD_VERIFY_SECRET: process.env.HOLD_VERIFY_SECRET || "screenshot-hold-secret",
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );

  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    let pair;
    try {
      pair = await capture(browser);
    } finally {
      await browser.close();
    }
    console.log(`left=${pair.left} right=${pair.right}`);
    console.log(`screenshot=${OUT_PATH} bytes=${statSync(OUT_PATH).size}`);
  } finally {
    server.kill();
    await rm(CAPTURE_VOTE_DIR, { recursive: true, force: true });
  }
}
