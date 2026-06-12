import { expect, test } from "@playwright/test";

test("arena renders two 3D canvases", async ({ page }) => {
  await page.goto("/");
  await page.locator("#arena").scrollIntoViewIfNeeded();
  await expect(page.locator("#left-canvas")).toBeVisible();
  await expect(page.locator("#right-canvas")).toBeVisible();
  await expect(page.locator("#vote-left")).toBeEnabled({ timeout: 30_000 });

  const sample = await page.locator("#left-canvas").evaluate(async (canvas) => {
    const target = canvas as HTMLCanvasElement;
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
  expect(sample.nonTransparent).toBeGreaterThan(500);
  expect(sample.colorSum).toBeGreaterThan(10_000);
});
