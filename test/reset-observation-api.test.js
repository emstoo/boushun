import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBoushunServer } from "../src/server.js";
import { JsonStore } from "../src/store/json-store.js";
import { collectDemo } from "../src/collectors/demo.js";
import { waitForCompletedScan } from "./helpers/wait-for-scan.js";

async function serve(t, options) {
  const app = await createBoushunServer({ host: "127.0.0.1", port: 0, startScheduler: false, allowedCIDRs: ["192.168.50.0/24"], ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const close = async () => { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); };
  t.after(close);
  return { ...app, base, close, get: async (url) => (await fetch(base + url)).json(),
    post: (url, body) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) };
}

test("[RST-01, RST-02, RST-03, DB-14] reset survives restart without collection or demo reseeding", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-reset-restart-"));
  let collections = 0;
  const collector = async () => { collections += 1; return collectDemo(); };
  const app = await serve(t, { dataDirectory: directory, collector });
  assert.equal(collections, 0);
  assert.equal((await app.get("/api/state")).snapshot, null);
  await app.store.saveSnapshot(collectDemo());
  await app.store.saveLayout({ "device:self": { x: 10, y: 10 } });
  await app.store.saveDeviceOverride("device:self", { name: "renamed.test" });
  await app.store.saveInterfacePolicy("eth0", { map: false });
  const before = await app.store.exportDatabase();
  assert.equal((await app.post("/api/database/reset", { confirmation: "RESET" })).status, 200);
  const empty = await app.get("/api/state");
  assert.equal(empty.snapshot, null);
  assert.deepEqual(empty.topology.nodes, []);
  assert.deepEqual(empty.layout, {});
  assert.deepEqual(empty.settings.interfaces, {});
  assert.deepEqual(empty.overrides.devices, {});
  assert.deepEqual(await app.get("/api/history"), []);
  const backupName = (await readdir(directory)).find((name) => name.includes(".reset."));
  assert.ok(backupName);
  const backup = JSON.parse(await readFile(path.join(directory, backupName), "utf8"));
  assert.deepEqual(backup.snapshots, before.state.snapshots);
  await app.close();
  const restarted = await serve(t, { dataDirectory: directory, collector, demo: true });
  assert.equal(collections, 0);
  assert.equal((await restarted.get("/api/state")).snapshot, null);
});

test("[RST-04] a request suspended before scan admission cannot survive a reset", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-reset-admission-"));
  const store = new JsonStore(directory);
  await store.initialize();
  await store.saveSnapshot(collectDemo());
  let collections = 0;
  const app = await serve(t, { store, collector: async () => { collections += 1; return collectDemo(); } });
  const originalRead = store.read.bind(store);
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  let intercept = true;
  store.read = async () => {
    const result = await originalRead();
    if (intercept) { intercept = false; entered(); await held; }
    return result;
  };
  const pending = app.post("/api/scan", { profile: "passive" });
  await waiting;
  assert.equal((await app.post("/api/database/reset", { confirmation: "RESET" })).status, 200);
  release();
  assert.equal((await pending).status, 409);
  assert.equal(collections, 0);
  assert.equal((await app.get("/api/database")).summary.snapshots, 0);
});

test("[OBS-10, OBS-11, TOP-11] cache retrieval never advances response presence and exports agree", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-presence-times-"));
  const app = await serve(t, { dataDirectory: directory, collector: async () => { throw new Error("Unexpected collection"); } });
  const first = "2026-09-17T01:00:00.000Z";
  const later = "2026-09-17T02:00:00.000Z";
  const raw = (time) => ({ id: time, observedAt: time, profile: "passive", interfaces: [], routes: [], evidence: [], warnings: [], sources: [],
    devices: [{ id: "device:cached", source: "neighbor-cache", state: "STALE", addresses: ["192.168.50.2"], evidenceIds: [] }] });
  await app.store.saveSnapshot({ ...raw(first), profile: "standard", scan: { method: "icmp-echo", cidr: "192.168.50.2/32", probes: [
    { address: "192.168.50.2", result: "response", observedAt: first },
  ] } });
  await app.store.saveSnapshot(raw(later));
  const state = await app.get("/api/state");
  const presence = state.presence["device:cached"];
  assert.equal(presence.lastResponseAt, first);
  assert.equal(presence.lastRetrievedAt, later);
  assert.equal(presence.responseCount, 1);
  assert.deepEqual((await app.get("/api/export")).inventory, state.inventory);
  const historical = await app.get(`/api/history/${encodeURIComponent(first)}`);
  assert.equal(historical.inventory.devices[0].observation.lastResponseAt, first);
  const csv = await (await fetch(app.base + "/api/export/inventory.csv")).text();
  assert.match(csv, /last_response_at/);
  assert.ok(csv.includes(first));
});

test("[LOC-01] local configuration is a supported explicit job", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-local-job-"));
  const calls = [];
  const app = await serve(t, { dataDirectory: directory, collector: async ({ profile }) => {
    calls.push(profile);
    return { id: "local-test", observedAt: "2026-09-17T01:00:00.000Z", profile, devices: [], interfaces: [], evidence: [], routes: [], sources: [], warnings: [] };
  } });
  const response = await app.post("/api/scan", { profile: "local" });
  assert.equal(response.status, 202);
  const { job } = await response.json();
  await waitForCompletedScan(`${app.base}/api/scans/${job.id}`);
  assert.deepEqual(calls, ["local"]);
});
