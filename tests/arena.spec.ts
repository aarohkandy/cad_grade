import { expect, test } from "@playwright/test";

test("arena renders two 3D canvases", async ({ page }) => {
  await page.goto("/");
  await page.locator("#arena").scrollIntoViewIfNeeded();
  await expect(page.locator("#left-canvas")).toBeVisible();
  await expect(page.locator("#right-canvas")).toBeVisible();
  await expect(page.locator(".streak-meter")).toBeVisible();
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: 30_000 });

  const sample = await page.locator("#left-canvas").screenshot();
  expect(sample.length).toBeGreaterThan(10_000);
});

test("arena shows full-screen result feedback after a vote", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: 30_000 });
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
