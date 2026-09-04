import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "line",
  outputDir: "test-results",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    trace: "retain-on-failure",
  },
});
