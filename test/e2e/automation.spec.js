import { expect, test } from "@playwright/test";
import { startSyntheticDemoServer } from "./demo-server.js";

test("[UI-16] schedules create, run, toggle, delete, and notifications become read", async ({ page }) => {
  const demo = await startSyntheticDemoServer({
    tcpServiceCollector: async ({ cidr, ports, observedAt }) => ({
      cidr,
      method: "tcp-connect",
      targetCount: 1,
      ports,
      portCount: ports.length,
      attemptCount: ports.length,
      openCount: 1,
      openHostCount: 1,
      outcomeCounts: { open: 1, closed: Math.max(0, ports.length - 1), "filtered-or-unreachable": 0, unreachable: 0, error: 0 },
      endpoints: [{ address: "192.168.50.30", port: ports[0], protocol: "tcp", service: "synthetic", latencyMs: 1, evidenceIds: ["evidence:automation"] }],
      evidence: [{ id: "evidence:automation", type: "tcp-service-open", source: "tcp-connect", observedAt, summary: "Synthetic scheduled service", raw: null }],
      source: { id: "tcp-services", label: "TCP service discovery", configured: true, status: "connected", recordCount: 1, message: "Synthetic scheduled service" },
    }),
  });

  try {
    await page.clock.setFixedTime(demo.demoTime);
    await page.goto(demo.baseURL);
    await page.locator('.nav-item[data-section="automation"]').click();
    await page.locator("#schedule-custom-ports").fill("8123");
    await page.locator("#schedule-interval").selectOption("15");
    await page.locator("#schedule-form").getByRole("button", { name: "Create schedule" }).click();
    await expect(page.locator(".schedule-item")).toHaveCount(1);
    await expect(page.locator("#automation-summary")).toContainText("1 schedule");

    await page.locator(".schedule-run").click();
    await expect(page.locator("#toast")).toContainText("completed");
    await page.locator('.nav-item[data-section="automation"]').click();
    await expect(page.locator(".schedule-item")).toContainText("Last run");
    await page.locator(".schedule-item").getByRole("button", { name: "Disable" }).click();
    await expect(page.locator(".schedule-item")).toContainText("Disabled");
    let state = await demo.store.read();
    expect(state.settings.serviceSchedules[0].enabled).toBe(false);

    const schedule = state.settings.serviceSchedules[0];
    await demo.store.appendPortNotifications([{
      fingerprint: "ui-16-notification",
      type: "new-port",
      scheduleId: schedule.id,
      snapshotId: state.snapshots.at(-1).id,
      observedAt: "2026-03-20T09:01:00.000Z",
      protocol: "tcp",
      address: "192.168.50.30",
      port: 8123,
      service: "synthetic",
    }]);
    await page.reload();
    await page.locator('.nav-item[data-section="automation"]').click();
    await expect(page.locator("#automation-nav-badge")).toHaveText("1");
    await expect(page.locator(".notification-item.unread")).toContainText("192.168.50.30:8123/tcp");
    await page.locator("#mark-notifications-read").click();
    await expect(page.locator(".notification-item.unread")).toHaveCount(0);

    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".schedule-item").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".schedule-item")).toHaveCount(0);
    state = await demo.store.read();
    expect(state.settings.serviceSchedules).toEqual([]);
  } finally {
    await demo.close();
  }
});
