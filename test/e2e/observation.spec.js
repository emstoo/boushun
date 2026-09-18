import { expect, test } from "@playwright/test";
import { startSyntheticDemoServer } from "./demo-server.js";

let demo;
test.beforeEach(async () => { demo = await startSyntheticDemoServer(); });
test.afterEach(async () => { await demo.close(); });

test("[OBS-01, OBS-12] cache candidates are opt-in and never counted as responding devices", async ({ page }) => {
  const raw = await demo.store.latest();
  raw.id = "synthetic-candidate";
  raw.devices.push({ id: "device:old-cache", name: "old-cache.test", addresses: ["192.168.50.222"],
    mac: "02:00:00:00:00:ee", state: "STALE", source: "neighbor-cache", evidenceIds: [] });
  await demo.store.saveSnapshot(raw);
  await page.clock.setFixedTime(demo.demoTime);
  await page.goto(demo.baseURL);
  await expect(page.locator(".graph-node", { hasText: "old-cache.test" })).toHaveCount(0);
  await page.locator('.nav-item[data-section="inventory"]').click();
  await expect(page.locator("#inventory-body")).not.toContainText("old-cache.test");
  await expect(page.locator("#candidate-inventory-body")).toBeHidden();
  await page.locator("#candidate-inventory summary").click();
  await expect(page.locator("#candidate-inventory-body")).toContainText("old-cache.test");
  await expect(page.locator("#candidate-inventory-body")).toContainText("unconfirmed");
  await expect(page.locator("#last-seen")).not.toContainText("Observed");
});

test("[RST-05] reset ignores delayed pre-reset automation and clears selected details", async ({ page }) => {
  await demo.store.saveServiceSchedule({ protocol: "tcp", cidr: "192.168.50.2/32", preset: "custom", customPorts: "443", intervalMinutes: 60 });
  await page.clock.install({ time: demo.demoTime });
  await page.goto(demo.baseURL);
  await expect(page.locator(".graph-node").first()).toBeVisible();
  await page.locator(".graph-node", { hasText: "storage.demo.test" }).click();
  await expect(page.locator("#detail-drawer")).toBeVisible();
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  await page.route("**/api/automation", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    entered();
    await blocked;
    await route.fulfill({ json: body });
  });
  await page.clock.runFor(30_000);
  await waiting;
  await page.locator('.nav-item[data-section="database"]').click();
  page.once("dialog", (dialog) => dialog.accept("RESET"));
  await page.locator("#database-reset").click();
  await expect(page.locator("#database-empty-status")).toBeVisible();
  await expect(page.locator("#detail-drawer")).toBeHidden();
  const delivered = page.waitForResponse("**/api/automation");
  release();
  await delivered;
  await page.locator('.nav-item[data-section="automation"]').click();
  await expect(page.locator("#schedule-list")).not.toContainText("192.168.50.2");
  await expect(page.locator(".graph-node")).toHaveCount(0);
});

test("[RST-05, MTL-11] reset invalidates a delayed MAC timeline index request", async ({ page }) => {
  await page.clock.setFixedTime(demo.demoTime);
  await page.goto(demo.baseURL);
  let release;
  let entered;
  let requestCount = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  await page.route("**/api/mac-timelines", async (route) => {
    requestCount += 1;
    const response = await route.fetch();
    if (requestCount === 1) {
      entered();
      await blocked;
    }
    await route.fulfill({ response });
  });

  await page.locator('.nav-item[data-section="history"]').click();
  await page.getByRole("button", { name: "Devices by MAC" }).click();
  await waiting;
  await expect(page.locator("#mac-timeline-status")).toContainText("Loading retained MAC history");

  await page.locator('.nav-item[data-section="database"]').click();
  page.once("dialog", (dialog) => dialog.accept("RESET"));
  await page.locator("#database-reset").click();
  await expect(page.locator("#database-empty-status")).toBeVisible();

  const delivered = page.waitForResponse("**/api/mac-timelines");
  release();
  await delivered;
  await page.locator('.nav-item[data-section="history"]').click();
  await expect.poll(() => requestCount).toBe(2);
  await expect(page.locator("#mac-timeline-status")).toContainText("No observations are saved");
});
