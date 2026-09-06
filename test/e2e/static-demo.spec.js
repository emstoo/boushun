import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startStaticDemoServer } from "./static-demo-server.js";

let demo;

test.beforeAll(async () => {
  demo = await startStaticDemoServer();
});

test.afterAll(async () => {
  await demo.close();
});

test("[UI-21, UI-22, DEP-08] Pages static demo renders read-only from the project subpath", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.clock.setFixedTime(demo.demoTime);
  await page.goto(demo.baseURL);
  await expect(page.getByRole("link", { name: "Boushun home" })).toBeVisible();
  await expect(page.getByText("Static demo", { exact: true })).toBeVisible();
  await expect(page.locator(".graph-node")).toHaveCount(9);

  const mapHeadingWidth = await page.getByRole("heading", { name: "Network map", exact: true })
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(mapHeadingWidth).toBeGreaterThan(90);

  await expect(page.locator("#passive-scan")).toBeDisabled();
  await expect(page.locator("#open-scan-dialog")).toBeDisabled();
  await expect(page.locator("#open-service-dialog")).toBeDisabled();
  await expect(page.locator("#open-udp-dialog")).toBeDisabled();

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.locator("#zoom-level")).not.toHaveText("100%");
  await page.getByRole("button", { name: "Reset zoom and map position" }).click();
  await expect(page.locator("#zoom-level")).toHaveText("100%");

  await page.locator(".graph-node", { hasText: "storage.demo.test" }).click();
  await expect(page.locator("#detail-drawer")).toBeVisible();
  await expect(page.locator("#drawer-title")).toHaveText("storage.demo.test");
  await expect(page.locator("#drawer-rescan-tcp")).toBeDisabled();
  await expect(page.locator("#drawer-rescan-udp")).toBeDisabled();
  await page.locator("#drawer-close").click();
  await expect(page.locator("#detail-drawer")).toBeHidden();

  const screens = [
    ["Open ports", "Open ports"],
    ["Inventory", "Device inventory"],
    ["History", "History timeline"],
    ["Automation", "Automation"],
    ["Database", "Database"],
  ];
  for (const [navigation, heading] of screens) {
    await page.locator(`.nav-item[data-section]`, { hasText: navigation }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }

  await expect(page.locator("#database-reset")).toBeDisabled();
  await expect(page.locator("#database-import")).toBeDisabled();
  await expect(page.locator("#database-collect-facts")).toBeDisabled();

  await page.locator('.nav-item[data-section="map"]').click();
  await expect(page.getByRole("heading", { name: "Network map", exact: true })).toBeVisible();

  const screenshotPath = path.resolve("test-results", "static-demo-pages.png");
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  expect(demo.apiRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
