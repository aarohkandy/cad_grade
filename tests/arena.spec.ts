import { expect, test } from "@playwright/test";

// Two STLs have to download, parse and render before the vote buttons enable. That took
// over 30s on this machine while other work was running, so the wait is deliberately
// generous: a slow box should not read as a broken arena.
const ARENA_READY_MS = 60_000;

test("arena renders two 3D canvases", async ({ page }) => {
  await page.goto("/");
  await page.locator("#arena").scrollIntoViewIfNeeded();
  await expect(page.locator("#left-canvas")).toBeVisible();
  await expect(page.locator("#right-canvas")).toBeVisible();
  await expect(page.locator(".streak-meter")).toBeVisible();
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: ARENA_READY_MS });

  const sample = await page.locator("#left-canvas").screenshot();
  expect(sample.length).toBeGreaterThan(10_000);
});

test("arena shows full-screen result feedback after a vote", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: ARENA_READY_MS });
  await page.locator("#vote-left").click();
  await expect(page.locator("#feedback-panel:not(.is-hidden)")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#feedback-panel")).toContainText("% agreed");
  await expect(page.locator("#result-flash.is-active")).toBeVisible();

  const overlay = await page.locator("#feedback-panel").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(overlay.top).toBeLessThanOrEqual(1);
  expect(overlay.left).toBeLessThanOrEqual(1);
  expect(overlay.width).toBeGreaterThanOrEqual(overlay.viewportWidth - 2);
  expect(overlay.height).toBeGreaterThanOrEqual(overlay.viewportHeight - 2);
});

test("arena offers a working retry when the battle request fails", async ({ page }) => {
  await page.route("**/api/battle**", (route) => route.fulfill({ status: 500, body: "{}" }));
  // On localhost a dead API falls back to /data/items.json, so that has to be
  // unreachable too before the arena is genuinely out of battles.
  await page.route("**/data/items.json", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.goto("/");

  const retry = page.locator("#retry-battle");
  await expect(retry).toBeVisible({ timeout: ARENA_READY_MS });
  await expect(retry).toBeEnabled();
  await expect(retry).toBeFocused();
  await expect(page.locator("#feedback-panel")).toContainText("Could not reach the arena.");
  await expect(page.locator("#vote-left")).toBeDisabled();

  await retry.click();
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled({ timeout: 15_000 });

  await page.unroute("**/api/battle**");
  await page.unroute("**/data/items.json");
  await retry.click();
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: ARENA_READY_MS });
  await expect(retry).toBeHidden();
});

test("arena offers a working retry when the model files fail to load", async ({ page }) => {
  await page.route("**/dataset/**/model.stl", (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/");

  const retry = page.locator("#retry-battle");
  await expect(retry).toBeVisible({ timeout: ARENA_READY_MS });
  await expect(retry).toBeEnabled();
  await expect(page.locator("#vote-left")).toBeDisabled();
  await expect(page.locator("#left-status")).toContainText("500");

  await page.unroute("**/dataset/**/model.stl");
  await retry.click();
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: ARENA_READY_MS });
  await expect(retry).toBeHidden();
});

test("arena drops the hold prompt when a verified vote fails", async ({ page }) => {
  await page.route("**/api/vote", (route) => route.fulfill({ status: 500, body: '{"error":"vote_failed"}' }));
  await page.goto("/");
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: ARENA_READY_MS });

  // The arena only asks for a hold when 12 votes land inside RAPID_VOTE_WINDOW_MS, which is
  // 10s, and loading two STLs can take longer than that. Seeding the history and clicking in
  // the same page task is the only way the timestamps are guaranteed to still be inside the
  // window when the handler reads them, however slow the machine is.
  await page.evaluate(() => {
    const now = Date.now();
    window.localStorage.setItem(
      "capybara-arena-vote-history",
      JSON.stringify(Array.from({ length: 14 }, (_, index) => now - index * 100)),
    );
    document.querySelector<HTMLButtonElement>("#vote-left")?.click();
  });

  await expect(page.locator("#hold-panel")).toBeVisible();

  const votePost = page.waitForRequest("**/api/vote");
  await page.locator("#hold-button").hover();
  await page.mouse.down();
  await votePost;
  await page.mouse.up();

  await expect(page.locator("#feedback-panel")).toContainText("Tap a model again", { timeout: 10_000 });
  await expect(page.locator("#hold-panel")).toBeHidden();
  await expect(page.locator("#vote-left")).toBeEnabled();

  // The panel inherits result-copy, which fades to opacity 0 in 760ms. toContainText reads
  // textContent and cannot see that, so the failure notice has to be checked for legibility.
  await page.waitForTimeout(1500);
  await expect(page.locator("#feedback-panel")).toHaveCSS("opacity", "1");
});

test("arena falls back to the published dataset when the battle API is down", async ({ page }) => {
  await page.route("**/api/battle**", (route) => route.fulfill({ status: 500, body: "{}" }));
  const datasetRequest = page.waitForRequest("**/data/items.json");
  await page.goto("/");
  await datasetRequest;

  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: ARENA_READY_MS });
  await expect(page.locator("#retry-battle")).toBeHidden();
});

test("arena shows how many votes the dataset has collected", async ({ page }) => {
  await page.route("**/api/stats", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        datasetId: "capybara-v1",
        itemCount: 94,
        totalVotes: 1500,
        acceptedVotes: 1207,
        mixedVoteCount: 0,
        mixedAcceptedVoteCount: 0,
        families: [],
        dataMode: "live",
      }),
    }),
  );
  await page.goto("/");

  await expect(page.locator("#stats-meter")).toBeVisible();
  await expect(page.locator("#stats-votes")).toHaveText("1,207");
  await expect(page.locator("#stats-items")).toHaveText("94");
});

test("arena hides the totals rather than inventing one when stats fail", async ({ page }) => {
  await page.route("**/api/stats", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.goto("/");

  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: ARENA_READY_MS });
  await expect(page.locator("#stats-meter")).toBeHidden();
});

test("arena accepts arrow-key voting shortcuts", async ({ page }) => {
  // Four full page loads, each waiting on two STLs, can outlast even the config's per-test
  // budget on a busy machine. This spec is genuinely slow rather than hung.
  test.slow();

  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    await page.goto("/");
    await page.evaluate(() => {
      window.localStorage.setItem("capybara-arena-vote-history", "[]");
    });
    await expect(page.locator("#vote-left")).toBeEnabled({ timeout: ARENA_READY_MS });
    await page.keyboard.press(key);
    await expect(page.locator("#feedback-panel:not(.is-hidden)")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#feedback-panel")).toContainText("% agreed");
  }
});
