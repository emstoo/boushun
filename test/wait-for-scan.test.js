import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { waitForCompletedScan } from "./helpers/wait-for-scan.js";

test("scan completion polling tolerates more than twenty pending responses", async () => {
  const calls = [];
  const result = await waitForCompletedScan("http://127.0.0.1/api/scans/test", {
    fetch: async (url, { signal }) => {
      calls.push(url);
      assert.equal(signal.aborted, false);
      return Response.json({ job: { status: calls.length < 25 ? "running" : "completed" } });
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 25);
});

for (const status of ["failed", "cancelled"]) {
  test(`scan completion polling fails immediately for ${status} jobs`, async () => {
    const calls = [];
    await assert.rejects(waitForCompletedScan("http://127.0.0.1/api/scans/test", {
      fetch: async () => {
        calls.push(status);
        return Response.json({ job: { status } });
      },
    }), /Scan must complete successfully/);
    assert.deepEqual(calls, [status]);
  });
}

test("scan completion polling times out pending jobs with their last status", async () => {
  await assert.rejects(waitForCompletedScan("http://127.0.0.1/api/scans/test", {
    timeoutMs: 30,
    fetch: async () => Response.json({ job: { status: "running" } }),
  }), /last status: running/);
});

test("scan completion deadline also aborts a stalled HTTP request", async () => {
  await assert.rejects(waitForCompletedScan("http://127.0.0.1/api/scans/test", {
    timeoutMs: 30,
    fetch: async (url, { signal }) => {
      await delay(10_000, undefined, { signal });
      assert.fail("Stalled request was not aborted");
    },
  }), /did not complete within 30ms/);
});
