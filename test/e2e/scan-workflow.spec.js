import { expect, test } from "@playwright/test";
import { collectDemo } from "../../src/collectors/demo.js";
import { startSyntheticDemoServer } from "./demo-server.js";

test("[UI-03, UI-04] scan progress survives reload and cancellation restores the controls", async ({ page }) => {
  let collectionCount = 0;
  const demo = await startSyntheticDemoServer({
    collector: async ({ profile, signal, onProgress } = {}) => {
      collectionCount += 1;
      const snapshot = collectDemo(() => new Date("2026-03-20T09:00:00.000Z"), { includeServices: true });
      if (collectionCount === 1) return snapshot;
      onProgress?.({ phase: "icmp", completed: 3, total: 12, percent: 25, message: "Checking synthetic targets", metrics: { responses: 2 } });
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
      });
    },
  });

  try {
    await page.clock.setFixedTime(demo.demoTime);
    await page.goto(demo.baseURL);
    await page.locator("#open-scan-dialog").click();
    await expect(page.locator("#scan-cidr option")).toHaveCount(1);
    await expect(page.locator("#scan-cidr")).toHaveValue("192.168.50.0/24");
    await page.locator("#scan-profile").selectOption("standard");
    await page.locator("#confirm-scan").click();
    await expect(page.locator("#scan-status")).toBeVisible();
    await expect(page.locator("#scan-status-title")).toContainText("Standard");
    await expect(page.locator("#scan-status-target")).toHaveText("192.168.50.0/24");
    await expect(page.locator("#scan-status-count")).toHaveText("3 / 12");
    await expect(page.locator("#scan-status-results")).toHaveText("Collecting evidence");
    await expect(page.locator("#scan-status-percent")).toHaveText("25%");

    await page.reload();
    await expect(page.locator("#scan-status")).toBeVisible();
    await expect(page.locator("#scan-status-message")).toContainText("Checking synthetic targets");
    await expect(page.locator("#global-cancel-scan")).toBeEnabled();
    await page.locator("#global-cancel-scan").click();
    await expect(page.locator("#toast")).toContainText("Scan cancelled");
    await expect(page.locator("#scan-status")).toBeHidden();
    await expect(page.locator("#open-scan-dialog")).toBeEnabled();
  } finally {
    await demo.close();
  }
});
