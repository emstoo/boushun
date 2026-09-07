import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Poll the public HTTP contract, allowing for filesystem/runner scheduling delays.
export async function waitForCompletedScan(url, { timeoutMs = 5_000, fetch: fetcher = globalThis.fetch } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let lastStatus = "unknown";
  try {
    while (true) {
      const response = await fetcher(url, { signal });
      assert.equal(response.status, 200, "Scan status endpoint must return HTTP 200");
      const { job } = await response.json();
      lastStatus = job.status;
      if (!["queued", "running", "cancelling"].includes(lastStatus)) {
        assert.equal(lastStatus, "completed", "Scan must complete successfully");
        return job;
      }
      await delay(10, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Scan did not complete within ${timeoutMs}ms (last status: ${lastStatus})`, { cause: error });
    }
    throw error;
  }
}
