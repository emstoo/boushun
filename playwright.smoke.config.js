import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config.js";

export default defineConfig(baseConfig, {
  testDir: "./test/smoke",
  outputDir: "test-results/smoke",
  timeout: 60_000,
  globalTimeout: 90_000,
  retries: 0,
  use: {
    navigationTimeout: 20_000,
    actionTimeout: 20_000,
  },
});
