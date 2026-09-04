import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectDemo } from "../src/collectors/demo.js";
import { createBoushunServer } from "../src/server.js";

test("[COL-10, JOB-03] cancelling collection does not persist a partial snapshot", async (t) => {
  let collectionCount = 0;
  let scanStarted;
  const started = new Promise((resolve) => { scanStarted = resolve; });
  const { baseUrl } = await startServer(t, {
    collector: async ({ signal } = {}) => {
      collectionCount += 1;
      if (collectionCount === 1) return collectDemo();
      scanStarted();
      return waitForAbort(signal);
    },
  });

  const startResponse = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "standard", cidr: "192.168.50.0/24" }),
  });
  assert.equal(startResponse.status, 202);
  const job = (await startResponse.json()).job;
  await started;
  assert.equal((await fetch(`${baseUrl}/api/scans/${job.id}`, { method: "DELETE" })).status, 202);
  assert.equal((await waitForTerminal(baseUrl, job.id)).status, "cancelled");
  assert.equal((await (await fetch(`${baseUrl}/api/database`)).json()).summary.snapshots, 1);
});

test("[TCP-08, UDP-09, JOB-03] cancelling service discovery does not persist TCP or UDP snapshots", async (t) => {
  let releaseStarted;
  const blockingCollector = ({ signal }) => {
    releaseStarted();
    return waitForAbort(signal);
  };
  const { baseUrl } = await startServer(t, {
    collector: async () => collectDemo(),
    tcpServiceCollector: blockingCollector,
    udpServiceCollector: blockingCollector,
  });

  for (const protocol of ["tcp", "udp"]) {
    const started = new Promise((resolve) => { releaseStarted = resolve; });
    const response = await fetch(`${baseUrl}/api/${protocol}-service-scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cidr: "192.168.50.7/32", preset: "custom", customPorts: protocol === "tcp" ? "443" : "5683" }),
    });
    assert.equal(response.status, 202);
    const job = (await response.json()).job;
    await started;
    assert.equal((await fetch(`${baseUrl}/api/scans/${job.id}`, { method: "DELETE" })).status, 202);
    assert.equal((await waitForTerminal(baseUrl, job.id)).status, "cancelled");
    assert.equal((await (await fetch(`${baseUrl}/api/database`)).json()).summary.snapshots, 1);
  }
});

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForTerminal(baseUrl, id) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = (await (await fetch(`${baseUrl}/api/scans/${id}`)).json()).job;
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Job ${id} did not reach a terminal state`);
}

async function startServer(t, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-server-cancel-"));
  const { server } = await createBoushunServer({
    host: "127.0.0.1",
    port: 0,
    dataDirectory: directory,
    startScheduler: false,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}
