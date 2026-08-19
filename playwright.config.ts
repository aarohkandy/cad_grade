import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.spec\.ts/,
  // A spec waits up to 60s for two STLs to render, so the per-test budget has to be well
  // clear of that or a slow machine fails the test before the arena has finished loading.
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    // The totals are rendered with toLocaleString, so the spec's "1,207" depends on this.
    locale: "en-US",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
