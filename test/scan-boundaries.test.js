import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectDemo } from "../src/collectors/demo.js";
import { collectLinux } from "../src/collectors/linux.js";
import { collectTcpServices } from "../src/collectors/tcp-services.js";
import { collectUdpServices } from "../src/collectors/udp-services.js";
import { readSnmpTargets } from "../src/collectors/snmp.js";
import { ScanManager } from "../src/scan/scan-manager.js";
import { createBoushunServer } from "../src/server.js";

test("[NET-05] unconfigured ICMP, TCP and UDP collectors never probe", async () => {
  let probes = 0;
  const probe = async () => { probes += 1; return { state: "closed" }; };
  for (const allowedCIDRs of [undefined, [], [""], [" "], ["invalid"]]) {
    const options = { cidr: "192.168.50.1/32", allowedCIDRs };
    for (const profile of ["standard", "deep"]) {
      await assert.rejects(collectLinux({
        ...options, profile,
        runner: async (command) => {
          if (command !== "ip") await probe();
          return { stdout: "[]", stderr: "" };
        },
        textReader: async () => "",
      }), /BOUSHUN_ALLOWED_CIDRS/);
    }
    await assert.rejects(collectTcpServices({ ...options, ports: [80], connector: probe }), /BOUSHUN_ALLOWED_CIDRS/);
    await assert.rejects(collectUdpServices({ ...options, ports: [53], prober: probe }), /BOUSHUN_ALLOWED_CIDRS/);
  }
  assert.equal(probes, 0);
});

test("[NET-05, API-03, SCH-01] unset and blank environment allowlists reject service scans and schedules", async (t) => {
  const previous = process.env.BOUSHUN_ALLOWED_CIDRS;
  t.after(() => {
    if (previous === undefined) delete process.env.BOUSHUN_ALLOWED_CIDRS;
    else process.env.BOUSHUN_ALLOWED_CIDRS = previous;
  });
  for (const value of [undefined, "", "   ", " , "]) {
    if (value === undefined) delete process.env.BOUSHUN_ALLOWED_CIDRS;
    else process.env.BOUSHUN_ALLOWED_CIDRS = value;
    let collectorCalls = 0;
    const scans = new ScanManager();
    const snapshot = collectDemo();
    const { server, config } = await createBoushunServer({
      host: "127.0.0.1", port: 0, startScheduler: false, scanManager: scans,
      store: { async initialize() {}, async latest() { return snapshot; }, async read() { return { snapshots: [snapshot], settings: {} }; } },
      collector: async () => { collectorCalls += 1; return snapshot; },
      tcpServiceCollector: async () => { collectorCalls += 1; },
      udpServiceCollector: async () => { collectorCalls += 1; },
    });
    assert.deepEqual(config.allowedCIDRs, []);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const endpoint of ["tcp-service-scan", "udp-service-scan", "schedules"]) {
        const response = await fetch(`${base}/api/${endpoint}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ cidr: "192.168.50.1/32", protocol: "tcp", preset: "custom", customPorts: "80", intervalMinutes: 15 }),
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /BOUSHUN_ALLOWED_CIDRS/);
      }
      assert.equal(collectorCalls, 0);
      assert.equal(scans.active(), null);
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("[API-11, EXT-10] malformed SNMP configuration never reaches public job errors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-snmp-boundary-"));
  const configPath = path.join(directory, "targets.json");
  t.after(async () => { await unlink(configPath); await rmdir(directory); });
  // Deliberately invalid synthetic input; never use a real credential fixture.
  await writeFile(configPath, '{"authKey":REVIEW_MARKER}', { mode: 0o600 });
  const scans = new ScanManager();
  const { server } = await createBoushunServer({
    host: "127.0.0.1", port: 0, startScheduler: false, scanManager: scans,
    allowedCIDRs: ["192.168.50.0/24"],
    store: { async initialize() {}, async latest() { return collectDemo(); }, async read() { return { settings: {} }; } },
    collector: async () => readSnmpTargets(configPath),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/scan`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "deep", cidr: "192.168.50.1/32" }),
  });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  await scans.wait(job.id);
  const publicJob = await (await fetch(`${base}/api/scans/${job.id}`)).json();
  assert.equal(publicJob.job.status, "failed");
  assert.equal(publicJob.job.error, "Unable to read or validate SNMP configuration");
  assert.equal(JSON.stringify(publicJob).includes("REVIEW"), false);
  assert.equal(JSON.stringify(publicJob).includes(directory), false);
  await writeFile(configPath, '{"targets":[null]}', { mode: 0o600 });
  await assert.rejects(readSnmpTargets(configPath), { code: "SNMP_CONFIG_ERROR", message: "Unable to read or validate SNMP configuration" });
});
