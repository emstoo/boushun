import { expect, test } from "@playwright/test";
import { startSyntheticDemoServer } from "./demo-server.js";

function tcpResult({ cidr, ports, observedAt }) {
  return {
    cidr, method: "tcp-connect", targetCount: 1, ports, portCount: ports.length, attemptCount: ports.length,
    openCount: 1, openHostCount: 1,
    outcomeCounts: { open: 1, closed: Math.max(0, ports.length - 1), "filtered-or-unreachable": 0, unreachable: 0, error: 0 },
    endpoints: [{ address: cidr.split("/")[0], port: ports[0], protocol: "tcp", service: "synthetic", latencyMs: 1, evidenceIds: ["evidence:target:tcp"] }],
    evidence: [{ id: "evidence:target:tcp", type: "tcp-service-open", source: "tcp-connect", observedAt, summary: "Synthetic target TCP response", raw: null }],
    source: { id: "tcp-services", label: "TCP service discovery", configured: true, status: "connected", recordCount: 1, message: "Synthetic target TCP response" },
  };
}

function udpResult({ cidr, ports, observedAt }) {
  return {
    cidr, method: "udp-probe", targetCount: 1, ports, portCount: ports.length, attemptCount: ports.length, transmissionCount: ports.length,
    openCount: 1, openHostCount: 1, uncertainCount: 0,
    outcomeCounts: { open: 1, closed: Math.max(0, ports.length - 1), "open-or-filtered": 0, unreachable: 0, error: 0 },
    endpoints: [{ address: cidr.split("/")[0], port: ports[0], protocol: "udp", state: "open", service: "synthetic", serviceConfidence: "verified", latencyMs: 1, evidenceIds: ["evidence:target:udp"] }],
    uncertainEndpoints: [],
    evidence: [{ id: "evidence:target:udp", type: "udp-service-open", source: "udp-probe", observedAt, summary: "Synthetic target UDP response", raw: null }],
    source: { id: "udp-services", label: "UDP service discovery", configured: true, status: "connected", recordCount: 1, message: "Synthetic target UDP response" },
  };
}

test("[UI-12] detail actions constrain TCP and UDP rescans and CSV to one address", async ({ page }) => {
  const calls = [];
  const demo = await startSyntheticDemoServer({
    tcpServiceCollector: async (input) => { calls.push(["tcp", input.cidr]); return tcpResult(input); },
    udpServiceCollector: async (input) => { calls.push(["udp", input.cidr]); return udpResult(input); },
  });
  try {
    await page.clock.setFixedTime(demo.demoTime);
    await page.goto(demo.baseURL);
    await page.locator(".graph-node", { hasText: "storage.demo.test" }).click();
    await page.locator("#drawer-rescan-tcp").click();
    await expect(page.locator("#toast")).toContainText("TCP service discovery completed");
    await page.locator('.nav-item[data-section="map"]').click();
    await page.locator(".graph-node", { hasText: "storage.demo.test" }).click();
    await page.locator("#drawer-rescan-udp").click();
    await expect(page.locator("#toast")).toContainText("UDP service discovery completed");
    expect(calls).toEqual([["tcp", "192.168.50.30/32"], ["udp", "192.168.50.30/32"]]);

    await page.locator('.nav-item[data-section="map"]').click();
    await page.locator(".graph-node", { hasText: "storage.demo.test" }).click();
    const download = page.waitForEvent("download");
    await page.locator("#drawer-export-target").click();
    expect((await download).suggestedFilename()).toMatch(/storage.*\.csv$/);
  } finally {
    await demo.close();
  }
});
