import { expect, test } from "@playwright/test";
import { startSyntheticDemoServer } from "./demo-server.js";

let demo;

test.beforeEach(async () => {
  demo = await startSyntheticDemoServer();
});

test.afterEach(async () => {
  await demo.close();
  demo = null;
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

test("[MTL-11, MTL-12] MAC history is searchable from History and reachable from Inventory", async ({ page }) => {
  await openDemo(page);
  await page.locator('.nav-item[data-section="history"]').click();
  await page.getByLabel("History view").selectOption("mac");
  await page.locator("#mac-timeline-selector").fill("02:00:00:00:00:30");
  await expect(page.locator("#mac-timeline-summary")).toContainText("storage.demo.test");
  await expect(page.locator("#mac-timeline-summary")).toContainText("Locally administered");
  await expect(page.locator("#mac-timeline-list .mac-timeline-entry")).toHaveCount(1);
  await expect(page.locator("#mac-timeline-list")).toContainText("192.168.50.30");
  await expect(page.locator("#mac-timeline-list")).not.toContainText(/offline|disconnected/i);

  await page.locator("#mac-timeline-selector").fill("");
  await expect(page.locator("#mac-timeline-summary")).toBeHidden();
  await expect(page.locator("#mac-timeline-list .mac-timeline-entry")).toHaveCount(0);

  await page.locator("#mac-timeline-selector").fill("020000000030");
  await expect(page.locator("#mac-timeline-selector")).toHaveValue("02:00:00:00:00:30");
  await expect(page.locator("#mac-timeline-summary")).toContainText("storage.demo.test");

  await page.locator("#mac-timeline-selector").fill("02-00-00-00-00-99");
  await expect(page.locator("#mac-timeline-selector")).toHaveValue("02:00:00:00:00:99");
  await expect(page.locator("#mac-timeline-summary")).toBeHidden();
  await expect(page.locator("#mac-timeline-status")).toContainText("No retained history was found");

  await page.locator("#mac-timeline-selector").fill("02-00-00-00-00-30");
  await expect(page.locator("#mac-timeline-selector")).toHaveValue("02:00:00:00:00:30");
  await expect(page.locator("#mac-timeline-summary")).toContainText("storage.demo.test");

  await page.locator('.nav-item[data-section="inventory"]').click();
  await page.locator("#inventory-body tr", { hasText: "storage.demo.test" }).getByRole("button", { name: /View details/ }).click();
  await expect(page.locator("#drawer-mac-timeline")).toBeVisible();
  await page.locator("#drawer-mac-timeline").click();
  await expect(page.locator("#history-section")).toBeVisible();
  await expect(page.getByLabel("History view")).toHaveValue("mac");
  await expect(page.locator("#mac-timeline-selector")).toHaveValue("02:00:00:00:00:30");
  await expect(page.locator("#mac-timeline-summary")).toContainText("storage.demo.test");
});

test("topology labels fit and basic details remain readable", async ({ page }) => {
  await openDemo(page);
  await expect(page.getByRole("complementary", { name: "Node status legend" })).toContainText("Responded");
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

test("[TOP-06, UI-08] topology controls filter nodes and links while keeping context visible", async ({ page }) => {
  await openDemo(page);
  const initialCaption = await page.locator("#graph-caption").textContent();
  await page.locator("#map-view").selectOption("physical");
  await expect(page.locator("#graph-caption")).toContainText("Physical");
  await expect(page.locator("#map-companion")).toBeVisible();
  await page.locator("#layer-filter").selectOption("l2");
  await expect(page.locator("#graph-caption")).toContainText("links");
  await page.locator("#confidence-filter").selectOption("verified");
  await expect(page.locator(".graph-node")).not.toHaveCount(9);
  await expect(page.getByRole("complementary", { name: "Node status legend" })).toContainText("Responded");
  await page.locator("#confidence-filter").selectOption("all");
  await page.locator("#layer-filter").selectOption("all");
  await page.locator("#map-view").selectOption("logical");
  await page.locator("#graph-search").fill("storage.demo.test");
  await expect(page.locator(".graph-node", { hasText: "storage.demo.test" })).not.toHaveClass(/dimmed/);
  await expect(page.locator(".graph-node.dimmed")).not.toHaveCount(0);
  expect(await page.locator("#graph-caption").textContent()).toBe(initialCaption);
});

test("[UI-09] keyboard node and link activation reaches details and the drawer closes", async ({ page }) => {
  await openDemo(page);
  const node = page.locator(".graph-node", { hasText: "storage.demo.test" });
  await node.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#drawer-title")).toHaveText("storage.demo.test");
  await page.locator("#drawer-close").click();
  await expect(page.locator("#detail-drawer")).toBeHidden();
  const link = page.locator(".graph-edge-hit").first();
  await link.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#detail-drawer")).toBeVisible();
  await expect(page.locator("#drawer-kind")).toContainText("L2 physical-or-l2");
  await page.locator("#drawer-close").click();
});

test("[UI-10] drag, pan, wheel, button zoom, and reset keep pins and viewport separate", async ({ page }) => {
  await openDemo(page);
  const node = page.locator(".graph-node", { hasText: "storage.demo.test" });
  const before = await node.getAttribute("transform");
  await node.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const event = (type, x, y) => new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    element.dispatchEvent(event("pointerdown", box.x + 20, box.y + 20));
    window.dispatchEvent(event("pointermove", box.x + 80, box.y + 55));
    window.dispatchEvent(event("pointerup", box.x + 80, box.y + 55));
  });
  await expect(node).not.toHaveAttribute("transform", before);
  await expect(page.locator("#detail-drawer")).toBeHidden();
  const saved = await (await page.request.get(`${demo.baseURL}/api/state`)).json();
  expect(saved.layout["logical:device:nas"]).toBeTruthy();

  const camera = page.locator(".graph-camera");
  const initialCamera = await camera.getAttribute("transform");
  await page.locator("#network-graph").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const event = (type, x, y) => new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    element.dispatchEvent(event("pointerdown", box.x + box.width - 8, box.y + box.height - 8));
    window.dispatchEvent(event("pointermove", box.x + box.width - 58, box.y + box.height - 48));
    window.dispatchEvent(event("pointerup", box.x + box.width - 58, box.y + box.height - 48));
  });
  await expect(camera).not.toHaveAttribute("transform", initialCamera);
  await page.locator("#network-graph").hover({ position: { x: 10, y: 10 } });
  await page.mouse.wheel(0, -300);
  await expect(page.locator("#zoom-level")).not.toHaveText("100%");
  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Reset zoom and map position" }).click();
  await expect(page.locator("#zoom-level")).toHaveText("100%");
  const pinnedAfterViewportReset = await (await page.request.get(`${demo.baseURL}/api/state`)).json();
  expect(pinnedAfterViewportReset.layout["logical:device:nas"]).toBeTruthy();
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect.poll(async () => Object.keys((await (await page.request.get(`${demo.baseURL}/api/state`)).json()).layout).length).toBe(0);
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
  await page.locator("#service-custom-ports").fill("70000");
  await expect(page.locator("#service-scan-summary")).toContainText(/invalid|between 1 and 65535/i);
  await expect(page.locator("#confirm-service-scan")).toBeDisabled();
  await page.locator("#service-dialog").getByRole("button", { name: "Close" }).click();

  await page.locator("#open-udp-dialog").click();
  await page.locator("#udp-custom-ports").fill("8123");
  await expect(page.locator("#udp-scan-summary")).toContainText("254 IP addresses");
  await page.locator("#udp-custom-ports").fill("70000");
  await expect(page.locator("#udp-scan-summary")).toContainText(/invalid|between 1 and 65535/i);
  await expect(page.locator("#confirm-udp-scan")).toBeDisabled();
  await page.locator("#udp-dialog").getByRole("button", { name: "Close" }).click();
});

test("[UI-11] identity override, merge, and split actions refresh projection and audit", async ({ page }) => {
  await openDemo(page);
  await page.locator('.nav-item[data-section="inventory"]').click();
  await page.locator("#inventory-body tr", { hasText: "storage.demo.test" }).getByRole("button", { name: /View details/ }).click();
  await page.locator("#device-name").fill("storage-edited.demo.test");
  await page.locator("#device-role").fill("backup-server");
  await page.locator("#device-tags").fill("critical, synthetic");
  await page.locator("#device-editor").getByRole("button", { name: /Save/ }).click();
  await expect(page.locator("#toast")).toContainText("audit record");
  await expect(page.locator("#drawer-title")).toHaveText("storage-edited.demo.test");

  page.once("dialog", (dialog) => dialog.accept("device:camera"));
  await page.locator("#merge-device").click();
  await expect(page.locator("#toast")).toContainText("Devices merged");
  const merged = await (await page.request.get(`${demo.baseURL}/api/state`)).json();
  expect(merged.inventory.devices.some((device) => device.id === "device:nas")).toBe(true);
  expect(merged.inventory.ipAssignments.some((assignment) => assignment.deviceId === "device:nas" && assignment.address === "192.168.50.41")).toBe(true);

  const replies = ["192.168.50.41", "camera-split.demo.test"];
  page.on("dialog", (dialog) => dialog.accept(replies.shift()));
  await page.locator("#split-device").click();
  await expect(page.locator("#toast")).toContainText("separate device");
  const split = await (await page.request.get(`${demo.baseURL}/api/state`)).json();
  const splitDevice = split.inventory.devices.find((device) => device.name === "camera-split.demo.test");
  expect(splitDevice).toBeTruthy();
  expect(split.inventory.ipAssignments.some((assignment) => assignment.deviceId === splitDevice.id && assignment.address === "192.168.50.41")).toBe(true);
  expect(split.overrides.audit.slice(-3).map((entry) => entry.action)).toEqual(expect.arrayContaining(["device.override", "device.merge", "device.split"]));
});

test("[UI-13, UI-19] interface policy persists and a server error restores the checkbox", async ({ page }) => {
  await openDemo(page);
  await page.locator('.nav-item[data-section="sources"]').click();
  const map = page.getByLabel("Map eth0");
  await map.uncheck();
  await page.locator('.nav-item[data-section="map"]').click();
  await expect(page.locator(".graph-node").filter({ hasText: /storage.*\.demo\.test/ })).toHaveCount(0);
  await page.locator('.nav-item[data-section="sources"]').click();
  await map.check();
  const identity = page.getByLabel("Identity eth0");
  await identity.uncheck();
  await page.locator('.nav-item[data-section="inventory"]').click();
  await expect(page.locator("#inventory-body tr").filter({ hasText: /storage.*\.demo\.test/ })).toHaveCount(0);
  await page.locator('.nav-item[data-section="sources"]').click();
  await identity.check();
  const scan = page.getByLabel("Scan eth0");
  await scan.uncheck();
  await expect(page.locator("#toast")).toContainText("updated");
  const disabled = await (await page.request.get(`${demo.baseURL}/api/state`)).json();
  expect(disabled.settings.interfaces.eth0.scan).toBe(false);
  await expect(page.locator("#open-scan-dialog")).toBeDisabled();
  await scan.check();
  await expect(page.locator("#open-scan-dialog")).toBeEnabled();

  await page.route("**/api/settings/interfaces/eth0", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "synthetic policy failure" }) }), { times: 1 });
  await scan.uncheck();
  await expect(page.locator("#toast")).toContainText("synthetic policy failure");
  await expect(scan).toBeChecked();
  await expect(scan).toBeEnabled();
  await expect.poll(async () => {
    const payload = await (await page.request.get(`${demo.baseURL}/api/state`)).json();
    return payload.settings.interfaces.eth0;
  }).toEqual({ map: true, identity: true, scan: true });
});

test("[UI-14] arbitrary history selections render semantic changes for their metadata", async ({ page }) => {
  const first = await demo.store.latest();
  const second = structuredClone(first);
  second.id = "demo-history-second";
  second.observedAt = "2026-03-20T10:00:00.000Z";
  second.devices.find((device) => device.id === "device:nas").name = "storage-renamed.demo.test";
  await demo.store.saveSnapshot(second);
  await openDemo(page);
  await page.locator('.nav-item[data-section="history"]').click();
  await expect(page.locator("#history-from option")).toHaveCount(2);
  await page.locator("#history-from").selectOption(first.id);
  await page.locator("#history-to").selectOption(second.id);
  await page.locator("#compare-history").click();
  await expect(page.locator("#history-result")).toContainText("meaningful changes");
  await expect(page.locator("#history-result")).toContainText(/storage|name|identity/i);
  await expect(page.locator("#history-from")).toHaveValue(first.id);
  await expect(page.locator("#history-to")).toHaveValue(second.id);
});

test("[UI-15] database preview is non-mutating and a failed import remains retryable", async ({ page }) => {
  await openDemo(page);
  await page.locator('.nav-item[data-section="database"]').click();
  const exported = await (await page.request.get(`${demo.baseURL}/api/database/export`)).json();
  const before = await demo.store.read();
  await page.locator("#database-file").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(page.locator("#database-import-preview")).toContainText("backup.json");
  await expect(page.locator("#database-import")).toBeEnabled();
  expect(await demo.store.read()).toEqual(before);
  await page.route("**/api/database/import", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "synthetic import failure" }) }), { times: 1 });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#database-import").click();
  await expect(page.locator("#toast")).toContainText("synthetic import failure");
  await expect(page.locator("#database-import")).toBeEnabled();
  expect(await demo.store.read()).toEqual(before);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#database-import").click();
  await expect(page.locator("#toast")).toContainText("Database imported");
  await expect(page.locator("#database-import-preview")).toContainText("Import complete");
});

test("[UI-20] current JSON, SVG, inventory, ports, and selected-target exports download", async ({ page }) => {
  await openDemo(page);
  for (const selector of ["#export-json", "#export-svg"]) {
    const download = page.waitForEvent("download");
    await page.locator(selector).click();
    expect((await download).suggestedFilename()).toMatch(/\.(json|svg)$/);
  }
  await page.locator('.nav-item[data-section="inventory"]').click();
  let download = page.waitForEvent("download");
  await page.locator("#export-inventory-csv").click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await page.locator('.nav-item[data-section="ports"]').click();
  download = page.waitForEvent("download");
  await page.locator("#export-ports-csv").click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await page.locator('.nav-item[data-section="map"]').click();
  await page.locator(".graph-node").filter({ hasText: /storage.*\.demo\.test/ }).click();
  download = page.waitForEvent("download");
  await page.locator("#drawer-export-target").click();
  expect((await download).suggestedFilename()).toMatch(/storage.*\.csv$/);
});

test("[UI-01, LOC-02] database reset exposes and recovers through the empty-state action", async ({ page }) => {
  await openDemo(page);
  await page.locator('.nav-item[data-section="database"]').click();
  await expect.poll(async () => Number(await page.locator("#database-stat-snapshots").textContent())).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole("button", { name: "Download database" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Import database" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reset database" })).toBeEnabled();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toMatch(/backup/i);
    expect(dialog.message()).toMatch(/schedule/i);
    await dialog.accept("RESET");
  });
  await page.getByRole("button", { name: "Reset database" }).click();
  await expect(page.locator("#database-empty-status")).toBeVisible();
  await expect(page.locator(".graph-node")).toHaveCount(0);
  await expect(page.locator("#detail-drawer")).toBeHidden();
  await expect(page.locator("#open-scan-dialog")).toBeDisabled();
  await page.locator("#database-collect-facts").click();
  await expect(page.locator("#database-empty-status")).toBeHidden();
  await expect(page.locator("#open-scan-dialog")).toBeEnabled();
  await expect(page.locator("#toast")).toContainText("Device confirmation has not been performed");
  const current = await (await page.request.get(`${demo.baseURL}/api/state`)).json();
  expect(current.inventory.devices.map((device) => device.id)).toEqual(["device:self"]);
  await expect(page.locator("#last-seen")).not.toContainText("Observed");
});
