import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.SMOKE_PORT || 4273);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(APP_ROOT, "test-results", "browser-smoke");
const SMOKE_VOTE_DIR = path.join(OUT_DIR, "local-data");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Preview server did not start at ${BASE_URL}`);
}

async function assertPortFree() {
  try {
    await fetch(BASE_URL);
  } catch {
    return;
  }
  throw new Error(`Smoke port is already in use: ${BASE_URL}`);
}

async function sampleCanvas(page, selector) {
  const canvas = page.locator(selector);
  const box = await canvas.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) return { byteLength: 0 };
  const screenshot = await page.screenshot({
    clip: {
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
      width: Math.max(1, Math.floor(box.width)),
      height: Math.max(1, Math.floor(box.height)),
    },
  });
  return { byteLength: screenshot.length };
}

async function waitForNonBlankCanvas(page, selector) {
  const deadline = Date.now() + 20_000;
  let latest = { byteLength: 0 };
  while (Date.now() < deadline) {
    latest = await sampleCanvas(page, selector);
    if (latest.byteLength > 10000) return latest;
    await sleep(250);
  }
  return latest;
}

async function assertCoreLoopVisible(page, name) {
  const state = await page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    };
    const inViewport = (rect) =>
      Boolean(
        rect &&
        rect.top >= -2 &&
        rect.left >= -2 &&
        rect.right <= window.innerWidth + 2 &&
        rect.bottom <= window.innerHeight + 2 &&
        rect.width > 0 &&
        rect.height > 0,
      );
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
      holdHidden: document.querySelector("#hold-panel")?.classList.contains("is-hidden") ?? false,
      leftButton: rectFor("#vote-left"),
      drawButton: rectFor("#vote-draw"),
      rightButton: rectFor("#vote-right"),
      leftCanvas: rectFor("#left-canvas"),
      rightCanvas: rectFor("#right-canvas"),
      leftEnabled: !document.querySelector("#vote-left")?.disabled,
      drawEnabled: !document.querySelector("#vote-draw")?.disabled,
      rightEnabled: !document.querySelector("#vote-right")?.disabled,
      allVisible:
        inViewport(rectFor("#vote-left")) &&
        inViewport(rectFor("#vote-draw")) &&
        inViewport(rectFor("#vote-right")) &&
        inViewport(rectFor("#left-canvas")) &&
        inViewport(rectFor("#right-canvas")),
    };
  });

  if (!state.leftEnabled || !state.drawEnabled || !state.rightEnabled) {
    throw new Error(`${name} vote controls were not enabled: ${JSON.stringify(state)}`);
  }
  if (!state.holdHidden) {
    throw new Error(`${name} hold verification was visible during normal voting`);
  }
  if (name === "desktop" && !state.allVisible) {
    throw new Error(`${name} core loop was not fully visible: ${JSON.stringify(state)}`);
  }
  if (name === "desktop" && state.scrollHeight > state.viewport.height + 2) {
    throw new Error(`${name} requires vertical scroll: ${JSON.stringify(state)}`);
  }
}

async function assertCanvasDragDoesNotVote(page, name) {
  const canvasBox = await page.locator("#left-canvas").boundingBox();
  if (!canvasBox) throw new Error(`${name} left canvas had no bounding box`);
  const beforeText = await page.locator("body").innerText();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.42, canvasBox.y + canvasBox.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.7, canvasBox.y + canvasBox.height * 0.48, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const afterText = await page.locator("body").innerText();
  const feedbackHidden = await page
    .locator("#feedback-panel")
    .evaluate((panel) => panel.classList.contains("is-hidden"));
  if (!feedbackHidden || beforeText !== afterText) {
    throw new Error(`${name} canvas drag unexpectedly voted or advanced`);
  }
}

async function assertVoteFeedbackAndAdvance(page, name) {
  await page.locator('[data-side="left"]').click();
  await page.locator("#feedback-panel:not(.is-hidden)").waitFor({ timeout: 10_000 });
  const feedback = await page.locator("#feedback-panel").innerText();
  if (!String(feedback || "").includes("% agreed")) {
    throw new Error(`${name} missing crowd estimate: ${feedback}`);
  }
  const overlay = await page.locator("#feedback-panel").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  if (
    overlay.left > 1 ||
    overlay.top > 1 ||
    overlay.width < overlay.viewportWidth - 2 ||
    overlay.height < overlay.viewportHeight - 2
  ) {
    throw new Error(`${name} feedback overlay did not cover viewport: ${JSON.stringify(overlay)}`);
  }
  await page.locator("#result-flash.is-active").waitFor({ timeout: 10_000 });
  const flashClass = await page.locator("#result-flash").getAttribute("class");
  if (!String(flashClass || "").match(/\bis-(good|bad)\b/)) {
    throw new Error(`${name} result flash did not indicate good/bad: ${flashClass}`);
  }
  await page.waitForFunction(() => !document.querySelector("#vote-left")?.disabled, null, { timeout: 30_000 });
  const holdHidden = await page.locator("#hold-panel").evaluate((panel) => panel.classList.contains("is-hidden"));
  if (!holdHidden) throw new Error(`${name} hold verification appeared after normal vote`);
}

async function assertRepeatedVotingStable(page, name) {
  if (name !== "desktop") return;
  const durations = [];
  for (let index = 0; index < 10; index += 1) {
    await page.waitForFunction(() => !document.querySelector("#vote-left")?.disabled, null, { timeout: 30_000 });
    const started = Date.now();
    await page.locator(index % 2 === 0 ? "#vote-right" : "#vote-left").click();
    await page.locator("#feedback-panel:not(.is-hidden)").waitFor({ timeout: 10_000 });
    const pieces = await page.locator(".confetti-piece").count();
    if (pieces > 20) throw new Error(`${name} particle cap failed: ${pieces}`);
    await page.waitForFunction(() => !document.querySelector("#vote-left")?.disabled, null, { timeout: 30_000 });
    durations.push(Date.now() - started);
  }
  const slowest = Math.max(...durations);
  if (slowest > 8000) throw new Error(`${name} repeated voting got slow: ${JSON.stringify(durations)}`);
  await page.evaluate(() => {
    window.localStorage.setItem("capybara-arena-vote-history", "[]");
  });
}

async function checkViewport(browser, name, viewport) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(30_000);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.evaluate(() => {
    window.localStorage.setItem("capybara-arena-vote-history", "[]");
  });
  await page.locator("#arena").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#vote-left")?.disabled, null, { timeout: 30_000 });
  const left = await waitForNonBlankCanvas(page, "#left-canvas");
  const right = await waitForNonBlankCanvas(page, "#right-canvas");
  if (left.byteLength <= 10000 || right.byteLength <= 10000) {
    throw new Error(`${name} canvas sample was blank: ${JSON.stringify({ left, right })}`);
  }
  await assertCoreLoopVisible(page, name);
  await assertCanvasDragDoesNotVote(page, name);
  await assertVoteFeedbackAndAdvance(page, name);
  await assertRepeatedVotingStable(page, name);
  const screenshotPath = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`${name}: left_bytes=${left.byteLength} right_bytes=${right.byteLength} screenshot=${screenshotPath}`);
  await page.close();
}

await mkdir(OUT_DIR, { recursive: true });
await rm(SMOKE_VOTE_DIR, { recursive: true, force: true });
await assertPortFree();
const server = spawn(
  process.execPath,
  ["./node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      LOCAL_VOTE_DIR: SMOKE_VOTE_DIR,
      IP_HASH_SALT: process.env.IP_HASH_SALT || "browser-smoke-ip-salt",
      HOLD_VERIFY_SECRET: process.env.HOLD_VERIFY_SECRET || "browser-smoke-hold-secret",
    },
    stdio: "ignore",
    windowsHide: true,
  },
);

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await checkViewport(browser, "desktop", { width: 1280, height: 720 });
    await checkViewport(browser, "mobile", { width: 390, height: 900 });
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
