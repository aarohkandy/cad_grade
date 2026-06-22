import { expect, test } from "@playwright/test";

test("arena renders two 3D canvases", async ({ page }) => {
  await page.goto("/");
  await page.locator("#arena").scrollIntoViewIfNeeded();
  await expect(page.locator("#left-canvas")).toBeVisible();
  await expect(page.locator("#right-canvas")).toBeVisible();
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: 30_000 });

  const sample = await page.locator("#left-canvas").screenshot();
  expect(sample.length).toBeGreaterThan(10_000);
});
