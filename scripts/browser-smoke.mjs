import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.SMOKE_PORT || 4273);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(APP_ROOT, "test-results", "browser-smoke");

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
  return page.locator(selector).evaluate(async (canvas) => {
    const target = canvas;
    const context = target.getContext("webgl2") || target.getContext("webgl");
    if (!context || target.width <= 0 || target.height <= 0) return { nonTransparent: 0, colorSum: 0 };
    const image = new Image();
    image.src = target.toDataURL("image/png");
    await image.decode();
    const sampler = document.createElement("canvas");
    sampler.width = 64;
    sampler.height = 64;
    const samplerContext = sampler.getContext("2d");
    if (!samplerContext) return { nonTransparent: 0, colorSum: 0 };
    samplerContext.drawImage(image, 0, 0, 64, 64);
    const pixels = samplerContext.getImageData(0, 0, 64, 64).data;
    let nonTransparent = 0;
    let colorSum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0) nonTransparent += 1;
      colorSum += pixels[index] + pixels[index + 1] + pixels[index + 2];
    }
    return { nonTransparent, colorSum };
  });
}

async function waitForNonBlankCanvas(page, selector) {
  const deadline = Date.now() + 20_000;
  let latest = { nonTransparent: 0, colorSum: 0 };
  while (Date.now() < deadline) {
    latest = await sampleCanvas(page, selector);
    if (latest.nonTransparent >= 500 && latest.colorSum > 10_000) return latest;
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
  const feedbackHidden = await page.locator("#feedback-panel").evaluate((panel) => panel.classList.contains("is-hidden"));
  if (!feedbackHidden || beforeText !== afterText) {
    throw new Error(`${name} canvas drag unexpectedly voted or advanced`);
  }
}

async function assertVoteFeedbackAndAdvance(page, name) {
  await page.locator('[data-side="left"]').click();
  await page.locator("#feedback-panel:not(.is-hidden)").waitFor({ timeout: 10_000 });
  const feedback = await page.locator("#feedback-title").textContent();
  if (!String(feedback || "").toLowerCase().includes("saved")) {
    throw new Error(`${name} unexpected feedback title: ${feedback}`);
  }
  await page.waitForFunction(() => !document.querySelector("#vote-left")?.disabled, null, { timeout: 30_000 });
  const holdHidden = await page.locator("#hold-panel").evaluate((panel) => panel.classList.contains("is-hidden"));
  if (!holdHidden) throw new Error(`${name} hold verification appeared after normal vote`);
}

async function checkViewport(browser, name, viewport) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(30_000);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("#arena").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#vote-left")?.disabled, null, { timeout: 30_000 });
  const left = await waitForNonBlankCanvas(page, "#left-canvas");
  const right = await waitForNonBlankCanvas(page, "#right-canvas");
  if (left.nonTransparent < 500 || right.nonTransparent < 500) {
    throw new Error(`${name} canvas sample was blank: ${JSON.stringify({ left, right })}`);
  }
  await assertCoreLoopVisible(page, name);
  await assertCanvasDragDoesNotVote(page, name);
  await assertVoteFeedbackAndAdvance(page, name);
  const screenshotPath = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`${name}: left=${left.nonTransparent} right=${right.nonTransparent} screenshot=${screenshotPath}`);
  await page.close();
}

await mkdir(OUT_DIR, { recursive: true });
await assertPortFree();
const server = spawn(
  process.execPath,
  [
    "./node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(PORT),
    "--strictPort",
  ],
  {
    cwd: APP_ROOT,
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
