import test from "node:test";
import assert from "node:assert/strict";
import { ScanManager } from "../src/scan/scan-manager.js";

test("[JOB-01, JOB-05] scan jobs expose sanitized progress and complete asynchronously", async () => {
  const manager = new ScanManager();
  const job = manager.start({ profile: "passive" }, async ({ onProgress }) => {
    onProgress({ phase: "facts", completed: 1, total: 2, message: "half", metrics: { openCount: 3, ignored: "not-a-number" } });
    return { id: "snapshot:1" };
  });
  await new Promise((resolve) => setImmediate(resolve));
  const completed = manager.get(job.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.resultSnapshotId, "snapshot:1");
  assert.equal(completed.progress.percent, 100);
  assert.deepEqual(completed.progress.metrics, { openCount: 3 });
});

test("[JOB-01] scan jobs can be awaited by background schedulers", async () => {
  const manager = new ScanManager();
  const started = manager.start({ kind: "tcp-services" }, async () => ({ id: "snapshot:scheduled" }));
  const completed = await manager.wait(started.id);
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.result.id, "snapshot:scheduled");
});

test("[JOB-03, JOB-04] a running job can be cancelled and remains terminal", async () => {
  const manager = new ScanManager();
  const job = manager.start({ profile: "standard" }, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
  }));
  await new Promise((resolve) => setImmediate(resolve));
  manager.cancel(job.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get(job.id).status, "cancelled");
  assert.equal(manager.cancel(job.id).status, "cancelled");
  assert.equal(manager.get("missing"), null);
});

test("[JOB-02, JOB-05] active collisions and failed tasks expose bounded public errors", async () => {
  const manager = new ScanManager();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const active = manager.start({ profile: "passive" }, async () => {
    await gate;
    return { id: "snapshot:active" };
  });
  assert.throws(() => manager.start({ profile: "passive" }, async () => null), (error) => error.code === "SCAN_ACTIVE");
  release();
  await manager.wait(active.id);

  const failed = manager.start({ profile: "deep" }, async ({ onProgress }) => {
    onProgress({
      phase: "x".repeat(100),
      completed: -5,
      total: 2,
      message: "m".repeat(200),
      metrics: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`unsafe key ${index}`, index])),
    });
    throw new Error("e".repeat(600));
  });
  const result = await manager.wait(failed.id);
  assert.equal(result.job.status, "failed");
  assert.equal(result.job.error.length, 500);
  assert.equal(result.job.progress.phase.length, 80);
  assert.equal(result.job.progress.message.length, 160);
  assert.equal(Object.keys(result.job.progress.metrics).length, 12);
  assert.equal(result.job.progress.completed, 0);
});

test("[JOB-06] retention removes old terminal jobs without evicting active work", async () => {
  const manager = new ScanManager({ maxJobs: 2 });
  const first = manager.start({ profile: "passive" }, async () => ({ id: "snapshot:first" }));
  await manager.wait(first.id);
  const second = manager.start({ profile: "passive" }, async () => ({ id: "snapshot:second" }));
  await manager.wait(second.id);
  let release;
  const third = manager.start({ profile: "passive" }, async () => new Promise((resolve) => { release = () => resolve({ id: "snapshot:third" }); }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get(first.id), null);
  assert.ok(manager.get(second.id));
  assert.equal(manager.active().id, third.id);
  release();
  await manager.wait(third.id);
});
