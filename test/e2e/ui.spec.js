import { expect, test } from "@playwright/test";
import { startSyntheticDemoServer } from "./demo-server.js";

let demo;

test.beforeAll(async () => {
  demo = await startSyntheticDemoServer();
});

test.afterAll(async () => {
  await demo.close();
});

async function openDemo(page) {
  await page.clock.setFixedTime(demo.demoTime);
  await page.goto(demo.baseURL);
  await expect(page.getByRole("link", { name: "Boushun home" })).toBeVisible();
  await expect(page.getByText("Demo mode", { exact: true })).toBeVisible();
}

test("[UI-01, UI-02] synthetic demo exposes every primary screen", async ({ page }) => {
  await openDemo(page);
  const screens = [
    ["Topology", "Network map"],
    ["Open ports", "Open ports"],
    ["Inventory", "Device inventory"],
    ["Evidence", "Evidence ledger"],
    ["Sources", "Data sources"],
    ["History", "History timeline"],
    ["Automation", "Automation"],
    ["Database", "Database"],
  ];

  for (const [navigation, heading] of screens) {
    await page.locator(`.nav-item[data-section]`, { hasText: navigation }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
});

test("[UI-08, UI-09, UI-10, UI-12] topology legend, viewport, details, and address actions work", async ({ page }) => {
  await openDemo(page);
  await expect(page.getByRole("complementary", { name: "Node status legend" })).toContainText("Online");
  await expect(page.locator(".graph-node")).toHaveCount(9);
  const nodeTitleClearances = await page.locator(".graph-node").evaluateAll((nodes) => nodes.map((node) => {
    const card = node.querySelector(".node-card").getBBox();
    const title = node.querySelector(".node-title").getBBox();
    return {
      label: node.getAttribute("aria-label"),
      cardRight: card.x + card.width,
      titleRight: title.x + title.width,
    };
  }));
  for (const clearance of nodeTitleClearances) {
    expect(clearance.titleRight, clearance.label).toBeLessThanOrEqual(clearance.cardRight - 6);
  }
  await expect(page.locator(".graph-node", { hasText: "access-point.demo.test" }).locator(".node-title"))
    .toHaveText("access-point.demo.test");

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.locator("#zoom-level")).not.toHaveText("100%");
  await page.getByRole("button", { name: "Reset zoom and map position" }).click();
  await expect(page.locator("#zoom-level")).toHaveText("100%");

  await page.locator(".graph-node", { hasText: "storage.demo.test" }).click();
  await expect(page.locator("#detail-drawer")).toBeVisible();
  await expect(page.locator("#drawer-title")).toHaveText("storage.demo.test");
  await expect(page.locator("#drawer-ports .drawer-port-row")).toHaveCount(2);
  await expect(page.locator("#drawer-ports .drawer-port-row").first()).toContainText("22");
  await expect(page.locator("#drawer-ports .drawer-port-row").first()).toContainText("TCP");
  await expect(page.locator("#drawer-actions-section").getByRole("button", { name: "Scan TCP" })).toBeVisible();
  await expect(page.locator("#drawer-actions-section").getByRole("button", { name: "Export CSV" })).toBeVisible();
});

test("[UI-05, UI-06, UI-07] service results and bounded custom-port previews stay distinct", async ({ page }) => {
  await openDemo(page);
  await page.locator('.nav-item[data-section="ports"]').click();
  await expect(page.locator("#ports-body tr")).toHaveCount(8);

  await page.locator("#port-protocol-filter").selectOption("tcp");
  await expect(page.locator("#ports-body tr")).toHaveCount(6);
  await page.locator("#port-search").fill("storage.demo.test");
  await expect(page.locator("#ports-body tr")).toHaveCount(2);

  await page.locator("#port-search").fill("");
  await page.locator("#port-protocol-filter").selectOption("udp");
  await page.locator("#port-state-filter").selectOption("uncertain");
  await expect(page.locator("#ports-body tr")).toHaveCount(1);
  await expect(page.locator("#ports-body tr")).toContainText("Open | filtered");

  await page.locator("#open-service-dialog").click();
  await expect(page.getByRole("heading", { name: "Discover TCP services?" })).toBeVisible();
  await page.locator("#service-custom-ports").fill("8123");
  await expect(page.locator("#service-scan-summary")).toContainText("254 IP addresses × 13 TCP ports");
  await page.locator("#service-dialog").getByRole("button", { name: "Close" }).click();
});

test("[UI-01, UI-03, UI-15] database reset exposes and recovers through the empty-state action", async ({ page }) => {
  await openDemo(page);
  await page.locator('.nav-item[data-section="database"]').click();
  await expect(page.locator("#database-stat-snapshots")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Download database" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Import database" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reset database" })).toBeEnabled();

  const reset = await page.request.post(`${demo.baseURL}/api/database/reset`, { data: { confirmation: "RESET" } });
  expect(reset.ok()).toBe(true);
  await page.reload();
  await expect(page.locator("#database-empty-status")).toBeVisible();
  await expect(page.locator("#open-scan-dialog")).toBeDisabled();
  await page.locator("#database-collect-facts").click();
  await expect(page.locator("#database-empty-status")).toBeHidden();
  await expect(page.locator("#open-scan-dialog")).toBeEnabled();
});
