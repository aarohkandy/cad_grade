import { afterEach, describe, expect, it, vi } from "vitest";
import { preloadStlGeometry } from "../src/client/stlViewer";

const MODEL_URL = "http://stl-viewer-cache.test/model.stl";

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geometry cache", () => {
  it("re-fetches a model whose first load failed", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    });

    preloadStlGeometry(MODEL_URL);
    await settle();
    expect(attempts).toBe(1);

    preloadStlGeometry(MODEL_URL);
    await settle();
    expect(attempts).toBe(2);
  });
});
