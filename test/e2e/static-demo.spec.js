import { mkdir, readFile } from "node:fs/promises";
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

test("static demo also loads from the site root", async ({ page }) => {
  const rootDemo = await startStaticDemoServer({ pagesBasePath: "/" });
  try {
    await page.goto(rootDemo.baseURL);
    await expect(page.locator(".graph-node")).toHaveCount(9);
    await expect(page.locator("#passive-scan")).toBeDisabled();
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-json").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("boushun-demo.json");
    expect(await download.failure()).toBeNull();
    expect(rootDemo.apiRequests).toEqual([]);
  } finally {
    await rootDemo.close();
  }
});

for (const [name, response, message] of [
  ["missing", { status: 404, body: "Missing" }, /Unable to load static demo fixture/],
  ["temporarily unavailable", { status: 503, body: "Unavailable" }, /Unable to load static demo fixture/],
  ["malformed", { status: 200, json: { readOnly: false, routes: {} } }, /Invalid static demo fixture/],
]) {
  test(`static demo keeps mutations disabled when its fixture is ${name}`, async ({ page }) => {
    const apiRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.includes("/api/")) apiRequests.push(request.url());
    });
    await page.clock.install();
    await page.route("**/demo-fixture.json", (route) => route.fulfill(response));
    await page.goto(demo.baseURL);
    await expect(page.locator("#load-error-message")).toHaveText(message);
    await page.clock.fastForward("00:10");
    await expect(page.locator("#load-error")).toBeVisible();
    await expect(page.locator("#loading-overlay")).toBeHidden();
    for (const id of ["passive-scan", "open-scan-dialog", "device-name", "schedule-protocol", "database-reset"]) {
      await expect(page.locator(`#${id}`)).toBeDisabled();
    }
    expect(apiRequests).toEqual([]);
    await page.unroute("**/demo-fixture.json");
    await page.getByRole("button", { name: "Reload demo", exact: true }).click();
    await expect(page.locator(".graph-node")).toHaveCount(9);
    await expect(page.locator("#load-error")).toBeHidden();
    await expect(page.locator("#passive-scan")).toBeDisabled();
    expect(apiRequests).toEqual([]);
  });
}

test("static demo exits loading after a stalled fixture and recovers on reload", async ({ page }) => {
  await page.clock.install();
  const requested = page.waitForRequest("**/demo-fixture.json");
  await page.route("**/demo-fixture.json", () => {});
  await page.goto(demo.baseURL, { waitUntil: "domcontentloaded" });
  await requested;
  await expect(page.locator("#loading-overlay")).toBeVisible();
  await page.clock.fastForward("00:16");
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await expect(page.locator("#load-error-message")).toContainText("timed out");
  await expect(page.locator("#passive-scan")).toBeDisabled();
  await page.clock.fastForward("00:10");
  await expect(page.locator("#load-error")).toBeVisible();
  await page.unroute("**/demo-fixture.json");
  await page.getByRole("button", { name: "Reload demo", exact: true }).click();
  await expect(page.locator(".graph-node")).toHaveCount(9);
  await expect(page.locator("#load-error")).toBeHidden();
  expect(demo.apiRequests).toEqual([]);
});

test("static demo keeps dynamically rendered schedules and interface policies disabled", async ({ page }) => {
  await page.route("**/demo-fixture.json", async (route) => {
    const response = await route.fetch();
    const fixture = await response.json();
    const schedules = [{
      id: "demo-schedule", protocol: "tcp", cidr: "192.168.50.0/24", preset: "common",
      intervalMinutes: 60, nextRunAt: "2030-01-02T04:04:05.000Z", enabled: true,
    }];
    fixture.routes["/api/state"].serviceSchedules = schedules;
    fixture.routes["/api/automation"].schedules = schedules;
    await route.fulfill({ response, json: fixture });
  });
  await page.goto(demo.baseURL);
  await expect(page.locator(".graph-node")).toHaveCount(9);
  for (const view of ["physical", "logical", "services"]) {
    await page.locator("#map-view").selectOption(view);
    await expect(page.locator(".schedule-actions button")).toHaveCount(3);
    for (const control of await page.locator('.schedule-actions button, #interface-body input, #schedule-form input, #schedule-form select, #schedule-form button').all()) {
      await expect(control).toBeDisabled();
    }
  }
  expect(demo.apiRequests).toEqual([]);
});

test("[UI-21, UI-22, DEP-08] Pages static demo renders read-only from the project subpath", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.clock.setFixedTime(demo.demoTime);
  await page.addInitScript(() => { window.initialFetch = window.fetch; });
  await page.goto(demo.baseURL);
  await expect(page.getByRole("link", { name: "Boushun home" })).toBeVisible();
  await expect(page.getByText("Static demo", { exact: true })).toBeVisible();
  await expect(page.locator(".graph-node")).toHaveCount(9);
  expect(await page.evaluate(() => window.fetch === window.initialFetch)).toBe(true);

  const mapHeadingWidth = await page.getByRole("heading", { name: "Network map", exact: true })
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(mapHeadingWidth).toBeGreaterThan(90);

  await expect(page.locator("#passive-scan")).toBeDisabled();
  await expect(page.locator("#open-scan-dialog")).toBeDisabled();
  await expect(page.locator("#open-service-dialog")).toBeDisabled();
  await expect(page.locator("#open-udp-dialog")).toBeDisabled();

  const jsonDownloadPromise = page.waitForEvent("download");
  await page.locator("#export-json").click();
  const jsonDownload = await jsonDownloadPromise;
  expect(jsonDownload.suggestedFilename()).toBe("boushun-demo.json");
  const jsonDownloadPath = await jsonDownload.path();
  const exported = JSON.parse(await readFile(jsonDownloadPath, "utf8"));
  expect(exported.snapshot.hostname).toBe("demo-probe");

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.locator("#zoom-level")).not.toHaveText("100%");
  await page.getByRole("button", { name: "Reset zoom and map position" }).click();
  await expect(page.locator("#zoom-level")).toHaveText("100%");
  await page.locator("#reset-layout").click();
  await expect(page.locator("#toast")).toHaveText("Automatic layout restored.");

  await page.locator(".graph-node", { hasText: "storage.demo.test" }).click();
  await expect(page.locator("#detail-drawer")).toBeVisible();
  await expect(page.locator("#drawer-title")).toHaveText("storage.demo.test");
  await expect(page.locator("#drawer-rescan-tcp")).toBeDisabled();
  await expect(page.locator("#drawer-rescan-udp")).toBeDisabled();
  await expect(page.locator("#device-name")).toBeDisabled();
  await expect(page.locator("#merge-device")).toBeDisabled();
  await expect(page.locator("#split-device")).toBeDisabled();
  await page.locator("#drawer-close").click();
  await expect(page.locator("#detail-drawer")).toBeHidden();

  await page.locator('.nav-item[data-section="ports"]').click();
  await expect(page.getByRole("heading", { name: "Open ports", exact: true })).toBeVisible();
  const portsDownloadPromise = page.waitForEvent("download");
  await page.locator("#export-ports-csv").click();
  const portsDownload = await portsDownloadPromise;
  expect(portsDownload.suggestedFilename()).toBe("boushun-open-ports.csv");
  const portsDownloadPath = await portsDownload.path();
  expect(await readFile(portsDownloadPath, "utf8")).toContain("storage.demo.test");

  await page.locator('.nav-item[data-section="inventory"]').click();
  await expect(page.getByRole("heading", { name: "Device inventory", exact: true })).toBeVisible();
  const inventoryDownloadPromise = page.waitForEvent("download");
  await page.locator("#export-inventory-csv").click();
  const inventoryDownload = await inventoryDownloadPromise;
  expect(inventoryDownload.suggestedFilename()).toBe("boushun-inventory.csv");
  const inventoryDownloadPath = await inventoryDownload.path();
  expect(await readFile(inventoryDownloadPath, "utf8")).toContain("storage.demo.test");

  await page.locator('.nav-item[data-section="sources"]').click();
  await expect(page.getByRole("heading", { name: "Data sources", exact: true })).toBeVisible();
  const interfaceControls = page.locator('#interface-body input[type="checkbox"]');
  expect(await interfaceControls.count()).toBeGreaterThan(0);
  for (let index = 0; index < await interfaceControls.count(); index += 1) {
    await expect(interfaceControls.nth(index)).toBeDisabled();
  }

  const screens = [
    ["History", "History timeline"],
    ["Automation", "Automation"],
    ["Database", "Database"],
  ];
  for (const [navigation, heading] of screens) {
    await page.locator(`.nav-item[data-section]`, { hasText: navigation }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }

  await expect(page.locator("#database-reset")).toBeDisabled();
  await expect(page.locator("#database-export")).toBeDisabled();
  await expect(page.locator("#database-file")).toBeDisabled();
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
