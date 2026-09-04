import test from "node:test";
import assert from "node:assert/strict";
import { ServiceScheduler } from "../src/scan/service-scheduler.js";

test("[SCH-01] service scheduler runs only due enabled schedules and advances the deadline", async () => {
  const schedules = [
    { id: "due", enabled: true, nextRunAt: "2026-08-23T00:00:00.000Z", intervalMinutes: 60 },
    { id: "later", enabled: true, nextRunAt: "2026-08-23T02:00:00.000Z", intervalMinutes: 60 },
    { id: "off", enabled: false, nextRunAt: "2026-08-23T00:00:00.000Z", intervalMinutes: 60 },
  ];
  const updates = [];
  const runs = [];
  const store = {
    read: async () => ({ settings: { serviceSchedules: schedules } }),
    updateServiceScheduleRuntime: async (id, patch) => { updates.push({ id, patch }); },
  };
  const scheduler = new ServiceScheduler({
    store,
    run: async (schedule) => { runs.push(schedule.id); },
    now: () => new Date("2026-08-23T01:00:00.000Z"),
  });
  await scheduler.tick();
  assert.deepEqual(runs, ["due"]);
  assert.equal(updates[0].patch.nextRunAt, "2026-08-23T02:00:00.000Z");
  assert.equal(updates.at(-1).patch.lastStatus, "completed");
});

test("[SCH-04] service scheduler records an active-scan collision as skipped", async () => {
  const updates = [];
  const error = Object.assign(new Error("Another scan is already running"), { code: "SCAN_ACTIVE" });
  const scheduler = new ServiceScheduler({
    store: {
      read: async () => ({ settings: { serviceSchedules: [{ id: "due", enabled: true, nextRunAt: "2026-08-23T00:00:00.000Z", intervalMinutes: 15 }] } }),
      updateServiceScheduleRuntime: async (id, patch) => { updates.push({ id, patch }); },
    },
    run: async () => { throw error; },
    now: () => new Date("2026-08-23T01:00:00.000Z"),
  });
  await scheduler.tick();
  assert.equal(updates.at(-1).patch.lastStatus, "skipped");
});

test("[SCH-03] multiple due schedules run in deadline order without reentrant duplication", async () => {
  const schedules = [
    { id: "later", enabled: true, nextRunAt: "2026-08-23T00:30:00.000Z", intervalMinutes: 60 },
    { id: "earlier", enabled: true, nextRunAt: "2026-08-23T00:00:00.000Z", intervalMinutes: 60 },
  ];
  const runs = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = new ServiceScheduler({
    store: {
      read: async () => ({ settings: { serviceSchedules: schedules } }),
      updateServiceScheduleRuntime: async () => {},
    },
    run: async (schedule) => {
      runs.push(schedule.id);
      if (schedule.id === "earlier") await gate;
    },
    now: () => new Date("2026-08-23T01:00:00.000Z"),
  });
  const firstTick = scheduler.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.tick();
  release();
  await firstTick;
  assert.deepEqual(runs, ["earlier", "later"]);
});

test("[SCH-05] failed schedules retain bounded diagnostics and advance their next run", async () => {
  const updates = [];
  const scheduler = new ServiceScheduler({
    store: {
      read: async () => ({ settings: { serviceSchedules: [{ id: "due", enabled: true, nextRunAt: "2026-08-23T00:00:00.000Z", intervalMinutes: 15 }] } }),
      updateServiceScheduleRuntime: async (id, patch) => { updates.push({ id, patch }); },
    },
    run: async () => { throw new Error("e".repeat(600)); },
    now: () => new Date("2026-08-23T01:00:00.000Z"),
  });
  await scheduler.tick();
  assert.equal(updates[0].patch.nextRunAt, "2026-08-23T01:15:00.000Z");
  assert.equal(updates.at(-1).patch.lastStatus, "failed");
  assert.equal(updates.at(-1).patch.lastError.length, 500);
});
