import { defineConfig } from "@playwright/test";

/**
 * Browser E2E for the Flyx MVP vertical slice.
 *
 * `globalSetup` builds the web app and spawns a deterministic Host
 * (apps/mvp-host/src/test-support/e2e-main.ts) on a random loopback port, then
 * exports FLYX_E2E_BASE_URL / FLYX_E2E_PAIRING_TOKEN so every test can pair
 * like a real phone browser.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "./e2e/.artifacts",
});
