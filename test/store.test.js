import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonStore } from "../src/store/json-store.js";

test("[DB-05] v1 state migrates on the next mutation and manual overrides are audited", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "state.json"), JSON.stringify({ version: 1, snapshots: [{ id: "old" }], layout: {} }), { mode: 0o600 });
  const store = new JsonStore(directory);
  await store.initialize();
  assert.equal((await store.read()).version, 2);
  await store.saveDeviceOverride("device:test", { name: "Router", role: "gateway", tags: ["core"] });
  await store.saveInterfacePolicy("docker0", { map: false, identity: false, scan: false });
  await store.saveSplitBatch([
    { sourceId: "device:test", targetId: "device:manual:192.168.1.2", addresses: ["192.168.1.2"], name: "192.168.1.2" },
    { sourceId: "device:test", targetId: "device:manual:192.168.1.3", addresses: ["192.168.1.3"], name: "192.168.1.3" },
  ]);
  const { schedule } = await store.saveServiceSchedule({
    protocol: "tcp",
    cidr: "192.168.1.0/24",
    preset: "lan-common",
    intervalMinutes: 60,
  });
  await store.updateServiceScheduleRuntime(schedule.id, { lastStatus: "completed" });
  await store.appendPortNotifications([{
    fingerprint: `${schedule.id}:snapshot:1:192.168.1.2:443/tcp`,
    type: "new-port",
    scheduleId: schedule.id,
    snapshotId: "snapshot:1",
    observedAt: "2026-08-23T00:00:00.000Z",
    protocol: "tcp",
    address: "192.168.1.2",
    port: 443,
    service: "https",
  }]);
  const state = await store.read();
  assert.equal(state.overrides.devices["device:test"].name, "Router");
  assert.equal(state.settings.interfaces.docker0.map, false);
  assert.equal(state.overrides.splits.length, 2);
  assert.equal(state.settings.serviceSchedules[0].lastStatus, "completed");
  assert.equal(state.notifications[0].readAt, null);
  assert.deepEqual(state.overrides.audit.map((item) => item.action), ["device.override", "interface.policy", "device.recommended-split", "schedule.create"]);
  await store.markNotificationsRead();
  assert.ok((await store.read()).notifications[0].readAt);
  assert.equal(JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")).version, 2);
});

test("[DB-06, DB-07, DB-08, DB-11, DB-13] database maintenance preserves recoverability", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-database-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.initialize();
  await store.saveSnapshot({ id: "snapshot:exported", observedAt: "2026-08-24T01:02:03.000Z", profile: "passive" });
  await store.saveLayout({ "device:test": { x: 120, y: 240 } });
  await store.saveDeviceOverride("device:test", { name: "Imported device" });

  const exported = await store.exportDatabase();
  assert.equal(exported.format, "boushun-database");
  assert.equal(exported.schemaVersion, 2);
  assert.deepEqual(await store.previewDatabaseImport(exported), {
    schemaVersion: 2,
    snapshots: 1,
    latestObservedAt: "2026-08-24T01:02:03.000Z",
    deviceOverrides: 1,
    merges: 0,
    splits: 0,
    layoutPositions: 1,
    interfacePolicies: 0,
    schedules: 0,
    notifications: 0,
  });
  const legacyExport = { ...exported, format: "lantern-database" };
  assert.equal((await store.previewDatabaseImport(legacyExport)).snapshots, 1);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("state.backup.")), []);

  await store.saveSnapshot({ id: "snapshot:later", observedAt: "2026-08-24T02:00:00.000Z", profile: "passive" });
  const imported = await store.importDatabase(exported);
  assert.match(imported.backup, /^state\.backup\..+\.import\.[0-9a-f-]+\.json$/);
  assert.deepEqual((await store.read()).snapshots.map((item) => item.id), ["snapshot:exported"]);
  assert.equal((await stat(path.join(directory, imported.backup))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path.join(directory, imported.backup), "utf8")).snapshots.length, 2);

  const beforeInvalid = await readFile(path.join(directory, "state.json"), "utf8");
  await assert.rejects(store.importDatabase({ version: 2, snapshots: [{ observedAt: "not-a-date" }] }), /valid id/);
  assert.equal(await readFile(path.join(directory, "state.json"), "utf8"), beforeInvalid);

  const reset = await store.resetDatabase();
  assert.match(reset.backup, /^state\.backup\..+\.reset\.[0-9a-f-]+\.json$/);
  assert.equal((await store.read()).snapshots.length, 0);
  for (let index = 0; index < 5; index += 1) await store.resetDatabase();
  const backups = (await readdir(directory)).filter((name) => name.startsWith("state.backup."));
  assert.equal(backups.length, 5);
});

test("[DB-01, DB-02] initialization enforces private directory and state permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-permissions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.initialize();
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, "state.json"))).mode & 0o777, 0o600);

  await writeFile(path.join(directory, "state.json"), JSON.stringify({ version: 2, snapshots: [] }), { mode: 0o666 });
  await store.initialize();
  assert.equal((await stat(path.join(directory, "state.json"))).mode & 0o777, 0o600);
});

test("[DB-03, DB-04] concurrent writes are serialized without lost updates and retention stays ordered", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory, { maxSnapshots: 10 });
  await store.initialize();
  const snapshots = Array.from({ length: 20 }, (_, index) => ({
    id: `snapshot:${index}`,
    observedAt: new Date(Date.UTC(2026, 7, 31, 0, 0, index)).toISOString(),
    profile: "passive",
  }));
  await Promise.all(snapshots.map((snapshot) => store.saveSnapshot(snapshot)));

  const state = await store.read();
  assert.deepEqual(state.snapshots.map((snapshot) => snapshot.id), snapshots.slice(-10).map((snapshot) => snapshot.id));
  assert.equal(new Set(state.snapshots.map((snapshot) => snapshot.id)).size, state.snapshots.length);
  const stateText = await readFile(path.join(directory, "state.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(stateText));
});

test("[DB-12] backup or primary rename failure preserves the readable current state", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.initialize();
  await store.saveSnapshot({ id: "snapshot:current", observedAt: "2026-08-31T00:00:00.000Z", profile: "passive" });
  const replacement = await store.exportDatabase();
  replacement.state.snapshots = [{ id: "snapshot:replacement", observedAt: "2026-08-31T01:00:00.000Z", profile: "passive" }];

  const backupFailureStore = new JsonStore(directory, {
    fileSystem: {
      rename: async (source, destination) => {
        if (path.basename(destination).startsWith("state.backup.")) throw Object.assign(new Error("injected backup failure"), { code: "EIO" });
        return rename(source, destination);
      },
    },
  });
  await backupFailureStore.initialize();
  await assert.rejects(backupFailureStore.importDatabase(replacement), /injected backup failure/);
  assert.deepEqual((await store.read()).snapshots.map((snapshot) => snapshot.id), ["snapshot:current"]);

  const primaryFailureStore = new JsonStore(directory, {
    fileSystem: {
      rename: async (source, destination) => {
        if (destination === path.join(directory, "state.json")) throw Object.assign(new Error("injected primary failure"), { code: "EIO" });
        return rename(source, destination);
      },
    },
  });
  await primaryFailureStore.initialize();
  await assert.rejects(primaryFailureStore.importDatabase(replacement), /injected primary failure/);
  assert.deepEqual((await store.read()).snapshots.map((snapshot) => snapshot.id), ["snapshot:current"]);
  const stateText = await readFile(path.join(directory, "state.json"), "utf8");
  assert.doesNotThrow(() => JSON.parse(stateText));
});

test("[SCH-02, SCH-07, SCH-08] schedule and notification limits preserve deduplication and selected read state", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-automation-limits-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.initialize();
  for (let index = 0; index < 10; index += 1) {
    await store.saveServiceSchedule({ protocol: "tcp", cidr: "192.168.1.0/24", preset: "custom", customPorts: "443", intervalMinutes: 60 });
  }
  await assert.rejects(
    store.saveServiceSchedule({ protocol: "tcp", cidr: "192.168.1.0/24", preset: "custom", customPorts: "443", intervalMinutes: 60 }),
    /No more than 10/,
  );

  const scheduleId = (await store.read()).settings.serviceSchedules[0].id;
  const notifications = Array.from({ length: 205 }, (_, index) => ({
    fingerprint: `${scheduleId}:snapshot:${index}:192.168.1.2:443/tcp`,
    type: "new-port",
    scheduleId,
    snapshotId: `snapshot:${index}`,
    observedAt: new Date(Date.UTC(2026, 7, 31, 0, 0, index)).toISOString(),
    protocol: "tcp",
    address: "192.168.1.2",
    port: 443,
    service: "https",
  }));
  await store.appendPortNotifications(notifications);
  const retained = (await store.read()).notifications;
  assert.equal(retained.length, 200);
  assert.equal(retained[0].fingerprint, notifications[5].fingerprint);
  assert.deepEqual(await store.appendPortNotifications([notifications.at(-1)]), []);

  const selectedId = retained[0].id;
  await store.markNotificationsRead([selectedId]);
  const marked = (await store.read()).notifications;
  assert.ok(marked.find((item) => item.id === selectedId).readAt);
  assert.equal(marked.find((item) => item.id !== selectedId).readAt, null);
});
