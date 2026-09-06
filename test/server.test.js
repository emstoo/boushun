import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectDemo } from "../src/collectors/demo.js";
import { createBoushunServer } from "../src/server.js";

test("HTTP integration contract", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "boushun-test-"));
  let tcpOpen = true;
  const { server } = await createBoushunServer({
    allowedCIDRs: ["192.168.50.0/24"],
    host: "127.0.0.1",
    port: 0,
    dataDirectory: temporaryDirectory,
    demo: true,
    collector: async () => {
      const snapshot = collectDemo();
      snapshot.devices.push({
        id: "device:mac:02:00:00:00:00:18",
        addresses: ["192.168.50.2", "192.168.50.8", "192.168.50.15"],
        mac: "02:00:00:00:00:18",
        name: null,
        manufacturer: "BUFFALO.INC",
        role: "host",
        state: "REACHABLE",
        interface: "eth0",
        identityConfidence: "strong",
        evidenceIds: [],
        source: "neighbor-cache",
      });
      return snapshot;
    },
    tcpServiceCollector: async ({ cidr, ports, observedAt }) => ({
      cidr,
      method: "tcp-connect",
      targetCount: 2,
      ports,
      portCount: ports.length,
      attemptCount: ports.length * 2,
      openCount: tcpOpen ? 1 : 0,
      openHostCount: tcpOpen ? 1 : 0,
      outcomeCounts: { open: tcpOpen ? 1 : 0, closed: ports.length * 2 - (tcpOpen ? 1 : 0), "filtered-or-unreachable": 0, unreachable: 0, error: 0 },
      endpoints: tcpOpen ? [{ address: "192.168.50.222", port: ports[0], protocol: "tcp", service: "test", latencyMs: 1, evidenceIds: ["evidence:tcp:test"] }] : [],
      evidence: tcpOpen ? [{ id: "evidence:tcp:test", type: "tcp-service-open", source: "tcp-connect", observedAt, summary: "Test TCP service", raw: null }] : [],
      source: { id: "tcp-services", label: "TCP service discovery", configured: true, status: "connected", recordCount: tcpOpen ? 1 : 0, message: `${tcpOpen ? 1 : 0} open service` },
    }),
    udpServiceCollector: async ({ cidr, ports, observedAt }) => ({
      cidr,
      method: "udp-probe",
      targetCount: 2,
      ports,
      portCount: ports.length,
      attemptCount: ports.length * 2,
      transmissionCount: ports.length * 3,
      openCount: 1,
      openHostCount: 1,
      uncertainCount: 1,
      outcomeCounts: { open: 1, closed: 0, "open-or-filtered": 1, unreachable: 0, error: 0 },
      endpoints: [{ address: "192.168.50.223", port: ports[0], protocol: "udp", state: "open", service: "test-udp", serviceConfidence: "verified", latencyMs: 2, evidenceIds: ["evidence:udp:test"] }],
      uncertainEndpoints: [{ address: "192.168.50.224", port: ports[0], protocol: "udp", state: "open-or-filtered", service: "test-udp", serviceConfidence: "inferred", latencyMs: null, evidenceIds: ["evidence:udp:summary"] }],
      evidence: [{ id: "evidence:udp:test", type: "udp-service-open", source: "udp-probe", observedAt, summary: "Test UDP service", raw: null }],
      source: { id: "udp-services", label: "UDP service discovery", configured: true, status: "connected", recordCount: 1, message: "1 confirmed UDP service" },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const address = server.address();
  await t.test("[API-01, API-06, INV-16] state exposes composed data and recommended splits", async () => {
  const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/state`);
  assert.equal(stateResponse.status, 200);
  assert.match(stateResponse.headers.get("content-security-policy"), /default-src 'self'/);
  const payload = await stateResponse.json();
  assert.equal(payload.demo, true);
  assert.ok(payload.snapshot.devices.length >= 5);
  assert.ok(payload.topology.links.some((link) => link.confidence === "verified"));
  assert.ok(Array.isArray(payload.sourceHealth));
  assert.ok(payload.presence["device:router"].observationCount >= 1);
  const recommendedSplitResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/devices/${encodeURIComponent("device:mac:02:00:00:00:00:18")}/recommended-split`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
  );
  assert.equal(recommendedSplitResponse.status, 201);
  assert.equal((await recommendedSplitResponse.json()).splits.length, 2);
  const splitState = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.ok(splitState.inventory.devices.some((item) => item.id === "device:manual:192.168.50.8"));
  });

  await t.test("[API-12] static root is available", async () => {
  const pageResponse = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(pageResponse.status, 200);
  });

  await t.test("[API-03, JOB-01] scan validation and asynchronous completion", async () => {
  const invalidScan = await fetch(`http://127.0.0.1:${address.port}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "invalid" }),
  });
  assert.equal(invalidScan.status, 400);

  const scanResponse = await fetch(`http://127.0.0.1:${address.port}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "passive" }),
  });
  assert.equal(scanResponse.status, 202);
  const started = await scanResponse.json();
  let job;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const jobResponse = await fetch(`http://127.0.0.1:${address.port}/api/scans/${started.job.id}`);
    job = (await jobResponse.json()).job;
    if (job.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(job.status, "completed");
  });

  await t.test("[API-03, INV-14] device overrides update only the projection and audit", async () => {
  const overrideResponse = await fetch(`http://127.0.0.1:${address.port}/api/devices/${encodeURIComponent("device:router")}/override`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Core router", role: "gateway", tags: ["core"] }),
  });
  assert.equal(overrideResponse.status, 200);
  const updatedState = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.equal(updatedState.inventory.devices.find((item) => item.id === "device:router").name, "Core router");
  assert.equal(updatedState.overrides.audit.at(-1).action, "device.override");
  });

  await t.test("[API-03, INV-06, INV-07] interface policies persist independently", async () => {
  const policyResponse = await fetch(`http://127.0.0.1:${address.port}/api/settings/interfaces/${encodeURIComponent("docker0")}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ map: false, identity: false, scan: false }),
  });
  assert.equal(policyResponse.status, 200);
  const settings = await (await fetch(`http://127.0.0.1:${address.port}/api/settings`)).json();
  assert.equal(settings.interfaces.docker0.identity, false);
  });

  await t.test("[API-02, TOP-10] history detail and arbitrary comparison are available", async () => {
  const history = await (await fetch(`http://127.0.0.1:${address.port}/api/history`)).json();
  assert.ok(history.length >= 2);
  const detailResponse = await fetch(`http://127.0.0.1:${address.port}/api/history/${encodeURIComponent(history[0].id)}`);
  assert.equal(detailResponse.status, 200);
  const compareResponse = await fetch(`http://127.0.0.1:${address.port}/api/compare?from=${encodeURIComponent(history[0].id)}&to=${encodeURIComponent(history.at(-1).id)}`);
  assert.equal(compareResponse.status, 200);
  assert.ok(Array.isArray((await compareResponse.json()).diff.events));
  });

  await t.test("[API-03, TCP-09, UDP-01] service presets are exposed", async () => {
  const presetsResponse = await fetch(`http://127.0.0.1:${address.port}/api/tcp-service-presets`);
  assert.equal(presetsResponse.status, 200);
  assert.ok((await presetsResponse.json()).some((item) => item.id === "lan-common"));

  const udpPresetsResponse = await fetch(`http://127.0.0.1:${address.port}/api/udp-service-presets`);
  assert.equal(udpPresetsResponse.status, 200);
  assert.ok((await udpPresetsResponse.json()).some((item) => item.id === "safe-common"));
  });

  await t.test("[INV-02, INV-08, INV-09, TOP-08, TOP-09] service observations compose and compare safely", async () => {
  const serviceScanResponse = await fetch(`http://127.0.0.1:${address.port}/api/tcp-service-scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cidr: "192.168.50.0/30", preset: "custom", customPorts: "8080" }),
  });
  assert.equal(serviceScanResponse.status, 202);
  const serviceStarted = await serviceScanResponse.json();
  let serviceJob;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    serviceJob = (await (await fetch(`http://127.0.0.1:${address.port}/api/scans/${serviceStarted.job.id}`)).json()).job;
    if (serviceJob.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(serviceJob.status, "completed");
  const serviceState = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.equal(serviceState.snapshot.profile, "current");
  assert.equal(serviceState.snapshot.sourceProfile, "tcp-services");
  assert.equal(serviceState.snapshot.tcpServices.openCount, 1);
  assert.ok(serviceState.inventory.services.some((item) => item.kind === "tcp-service"));
  assert.equal(serviceState.tcpServiceObservation.endpoints[0].address, "192.168.50.222");

  const laterPassiveResponse = await fetch(`http://127.0.0.1:${address.port}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "passive" }),
  });
  assert.equal(laterPassiveResponse.status, 202);
  const laterPassiveStarted = await laterPassiveResponse.json();
  let laterPassiveJob;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    laterPassiveJob = (await (await fetch(`http://127.0.0.1:${address.port}/api/scans/${laterPassiveStarted.job.id}`)).json()).job;
    if (laterPassiveJob.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(laterPassiveJob.status, "completed");
  const laterState = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.notEqual(laterState.snapshot.id, serviceState.snapshot.id);
  assert.equal(laterState.snapshot.profile, "current");
  assert.equal(laterState.snapshot.sourceProfile, "demo");
  assert.equal(laterState.snapshot.tcpServices.openCount, 1);
  assert.equal(laterState.sourceHealth.find((item) => item.id === "tcp-services").status, "connected");
  assert.equal(laterState.tcpServiceObservation.endpoints[0].address, "192.168.50.222");

  const udpScanResponse = await fetch(`http://127.0.0.1:${address.port}/api/udp-service-scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cidr: "192.168.50.0/30", preset: "custom", customPorts: "5683" }),
  });
  assert.equal(udpScanResponse.status, 202);
  const udpStarted = await udpScanResponse.json();
  let udpJob;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    udpJob = (await (await fetch(`http://127.0.0.1:${address.port}/api/scans/${udpStarted.job.id}`)).json()).job;
    if (udpJob.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(udpJob.status, "completed");
  const udpState = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.equal(udpState.snapshot.profile, "current");
  assert.equal(udpState.snapshot.sourceProfile, "udp-services");
  assert.equal(udpState.udpServiceObservation.endpoints[0].address, "192.168.50.223");
  assert.equal(udpState.udpServiceObservation.uncertainEndpoints[0].state, "open-or-filtered");
  assert.ok(udpState.inventory.services.some((item) => item.kind === "udp-service"));
  assert.ok(udpState.inventory.services.some((item) => item.kind === "tcp-service"));
  assert.equal(udpState.inventory.services.some((item) => item.addresses?.includes("192.168.50.224")), false);

  const serviceCompare = await (await fetch(
    `http://127.0.0.1:${address.port}/api/compare?from=${encodeURIComponent(serviceState.snapshot.id)}&to=${encodeURIComponent(udpState.snapshot.id)}`,
  )).json();
  assert.ok(serviceCompare.diff.events.some((event) => event.type === "service.added" && event.entityId.startsWith("service:udp:")));
  assert.equal(serviceCompare.diff.events.some((event) => event.type === "service.removed" && event.entityId.startsWith("service:tcp:")), false);

  const historicalUdp = await (await fetch(
    `http://127.0.0.1:${address.port}/api/history/${encodeURIComponent(udpState.snapshot.id)}`,
  )).json();
  assert.ok(historicalUdp.inventory.services.some((item) => item.kind === "tcp-service"));
  assert.ok(historicalUdp.inventory.services.some((item) => item.kind === "udp-service"));

  const repeatTcpResponse = await fetch(`http://127.0.0.1:${address.port}/api/tcp-service-scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cidr: "192.168.50.0/30", preset: "custom", customPorts: "8080" }),
  });
  const repeatTcpStarted = await repeatTcpResponse.json();
  let repeatTcpJob;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    repeatTcpJob = (await (await fetch(`http://127.0.0.1:${address.port}/api/scans/${repeatTcpStarted.job.id}`)).json()).job;
    if (repeatTcpJob.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(repeatTcpJob.status, "completed");
  const repeatedState = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.equal(repeatedState.tcpServiceObservation.changes.comparable, true);
  assert.equal(repeatedState.tcpServiceObservation.changes.added.length, 0);
  assert.equal(repeatedState.tcpServiceObservation.changes.removed.length, 0);
  assert.deepEqual(repeatedState.tcpServiceObservation.closedEndpoints, []);
  assert.equal(repeatedState.tcpServiceObservation.endpoints[0].change, "unchanged");

  tcpOpen = false;
  const closedScan = await fetch(`http://127.0.0.1:${address.port}/api/tcp-service-scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cidr: "192.168.50.0/30", preset: "custom", customPorts: "8080" }),
  });
  const closedStarted = await closedScan.json();
  let closedJob;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    closedJob = (await (await fetch(`http://127.0.0.1:${address.port}/api/scans/${closedStarted.job.id}`)).json()).job;
    if (closedJob.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const closedState = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.equal(closedState.tcpServiceObservation.closedEndpoints[0].state, "not-open");
  });

  await t.test("[SCH-01, SCH-06, SCH-07] schedules validate, run, and notify", async () => {
  const invalidSchedule = await fetch(`http://127.0.0.1:${address.port}/api/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "tcp", cidr: "192.168.50.0/30", preset: "custom", customPorts: "8080", intervalMinutes: 5 }),
  });
  assert.equal(invalidSchedule.status, 400);
  const scheduleResponse = await fetch(`http://127.0.0.1:${address.port}/api/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "tcp", cidr: "192.168.50.0/30", preset: "custom", customPorts: "8080", intervalMinutes: 60 }),
  });
  assert.equal(scheduleResponse.status, 201);
  const schedule = (await scheduleResponse.json()).schedule;
  const automation = await (await fetch(`http://127.0.0.1:${address.port}/api/automation`)).json();
  assert.equal(automation.schedules[0].id, schedule.id);

  tcpOpen = true;
  const scheduledResponse = await fetch(`http://127.0.0.1:${address.port}/api/schedules/${encodeURIComponent(schedule.id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(scheduledResponse.status, 202);
  const scheduledStarted = await scheduledResponse.json();
  let scheduledJob;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    scheduledJob = (await (await fetch(`http://127.0.0.1:${address.port}/api/scans/${scheduledStarted.job.id}`)).json()).job;
    if (scheduledJob.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(scheduledJob.status, "completed");
  const notified = await (await fetch(`http://127.0.0.1:${address.port}/api/automation`)).json();
  assert.equal(notified.notifications[0].type, "new-port");
  assert.equal(notified.notifications[0].port, 8080);
  });

  await t.test("[API-03, API-08, API-10] exports and invalid service input follow the API contract", async () => {
  const portsCsvResponse = await fetch(`http://127.0.0.1:${address.port}/api/export/ports.csv`);
  assert.equal(portsCsvResponse.status, 200);
  assert.match(portsCsvResponse.headers.get("content-disposition"), /boushun-open-ports\.csv/);
  assert.match(await portsCsvResponse.text(), /"192\.168\.50\.222","8080","tcp"/);
  const inventoryCsvResponse = await fetch(`http://127.0.0.1:${address.port}/api/export/inventory.csv`);
  assert.equal(inventoryCsvResponse.status, 200);
  assert.match(await inventoryCsvResponse.text(), /"suggested_name"/);

  const invalidPortResponse = await fetch(`http://127.0.0.1:${address.port}/api/tcp-service-scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cidr: "192.168.50.0/30", preset: "custom", customPorts: "70000" }),
  });
  assert.equal(invalidPortResponse.status, 400);
  });

  await t.test("[INV-01, DB-06, DB-07, DB-10, DB-11] database status, export, preview, reset, and import remain recoverable", async () => {
  const databaseResponse = await fetch(`http://127.0.0.1:${address.port}/api/database`);
  assert.equal(databaseResponse.status, 200);
  const databaseStatus = await databaseResponse.json();
  assert.equal(databaseStatus.summary.schemaVersion, 2);
  assert.ok(databaseStatus.summary.snapshots >= 1);
  assert.equal(databaseStatus.maxImportBytes, 25 * 1024 * 1024);

  const databaseExportResponse = await fetch(`http://127.0.0.1:${address.port}/api/database/export`);
  assert.equal(databaseExportResponse.status, 200);
  assert.match(databaseExportResponse.headers.get("content-disposition"), /boushun-database-/);
  const databaseExport = await databaseExportResponse.json();
  assert.equal(databaseExport.format, "boushun-database");

  const largePreviewDatabase = structuredClone(databaseExport);
  largePreviewDatabase.state.snapshots[0].importPadding = "x".repeat(70 * 1024);
  const databasePreviewResponse = await fetch(`http://127.0.0.1:${address.port}/api/database/import/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ database: largePreviewDatabase }),
  });
  assert.equal(databasePreviewResponse.status, 200);
  assert.equal((await databasePreviewResponse.json()).summary.snapshots, databaseExport.state.snapshots.length);

  const unconfirmedImport = await fetch(`http://127.0.0.1:${address.port}/api/database/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "yes", database: databaseExport }),
  });
  assert.equal(unconfirmedImport.status, 400);

  const databaseResetResponse = await fetch(`http://127.0.0.1:${address.port}/api/database/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "RESET" }),
  });
  assert.equal(databaseResetResponse.status, 200);
  assert.match((await databaseResetResponse.json()).backup, /\.reset\./);
  const emptyDatabase = await (await fetch(`http://127.0.0.1:${address.port}/api/database`)).json();
  assert.equal(emptyDatabase.summary.snapshots, 0);
  const emptyState = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.equal(emptyState.snapshot, null);
  assert.equal(emptyState.inventory, null);
  assert.deepEqual(emptyState.topologies.logical.nodes, []);
  assert.deepEqual(emptyState.topologies.logical.links, []);

  const databaseImportResponse = await fetch(`http://127.0.0.1:${address.port}/api/database/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "IMPORT", database: databaseExport }),
  });
  assert.equal(databaseImportResponse.status, 200);
  assert.match((await databaseImportResponse.json()).backup, /\.import\./);
  const restoredDatabase = await (await fetch(`http://127.0.0.1:${address.port}/api/database`)).json();
  assert.equal(restoredDatabase.summary.snapshots, databaseExport.state.snapshots.length);
  });
});

test("[DB-10] database replacement is rejected while a scan is active", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "boushun-database-busy-"));
  let releaseScan;
  const scanGate = new Promise((resolve) => { releaseScan = resolve; });
  let collectionCount = 0;
  const { server } = await createBoushunServer({
    host: "127.0.0.1",
    port: 0,
    dataDirectory: temporaryDirectory,
    startScheduler: false,
    collector: async () => {
      collectionCount += 1;
      if (collectionCount > 1) await scanGate;
      return collectDemo();
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    releaseScan();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  const address = server.address();
  const startedResponse = await fetch(`http://127.0.0.1:${address.port}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "passive" }),
  });
  assert.equal(startedResponse.status, 202);
  const started = await startedResponse.json();
  const databaseExport = await (await fetch(`http://127.0.0.1:${address.port}/api/database/export`)).json();
  const backupsBefore = (await readdir(temporaryDirectory)).filter((name) => name.startsWith("state.backup."));
  const resetResponse = await fetch(`http://127.0.0.1:${address.port}/api/database/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "RESET" }),
  });
  assert.equal(resetResponse.status, 409);
  assert.match((await resetResponse.json()).error, /active scan/);
  const importResponse = await fetch(`http://127.0.0.1:${address.port}/api/database/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmation: "IMPORT", database: databaseExport }),
  });
  assert.equal(importResponse.status, 409);
  assert.match((await importResponse.json()).error, /active scan/);
  assert.deepEqual(
    (await readdir(temporaryDirectory)).filter((name) => name.startsWith("state.backup.")),
    backupsBefore,
  );
  releaseScan();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const scan = await (await fetch(`http://127.0.0.1:${address.port}/api/scans/${started.job.id}`)).json();
    if (scan.job.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
});
