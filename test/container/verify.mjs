import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, stat, unlink } from "node:fs/promises";

const run = promisify(execFile);
const base = "http://127.0.0.1:45177";
const phase = process.argv[2];
const positions = { "device:self": { x: 123, y: 456 } };
const api = async (endpoint, method = "GET", body) => {
  const response = await fetch(`${base}/api/${endpoint}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, method === "POST" ? 202 : 200, endpoint);
  return response.json();
};

assert.notEqual(process.getuid(), 0);
const state = await api("state");
assert.equal(state.sourceHealth.find((source) => source.id === "local-network")?.status, "connected");
assert.ok(state.snapshot.interfaces.some((item) => item.name === "boushun0"
  && item.addresses.some((address) => address.address === "192.168.50.1")));
assert.equal((await stat("/data")).mode & 0o777, 0o700);
assert.equal((await stat("/data/state.json")).mode & 0o777, 0o600);

if (phase === "before") {
  await run("ping", ["-n", "-c", "1", "-W", "1", "192.168.50.1"], { timeout: 3_000 });
  const { job } = await api("tcp-service-scan", "POST", { cidr: "192.168.50.1/32", preset: "custom", customPorts: "45178" });
  let completed;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await api(`scans/${job.id}`);
    if (["failed", "cancelled"].includes(result.job.status)) throw new Error("Synthetic collection failed");
    if (result.job.status === "completed") { completed = result.job; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(completed, "Synthetic scan must finish within its deadline");
  const observed = await api("state");
  assert.equal(observed.sourceHealth.find((source) => source.id === "local-network")?.status, "connected");
  assert.ok(observed.tcpServiceObservation.endpoints.some((item) => item.address === "192.168.50.1" && item.port === 45178));
  await api("layout", "PUT", { positions });
  await writeFile("/data/acceptance-baseline.json", JSON.stringify((await api("database/export")).state), { flag: "wx", mode: 0o600 });
  // Existing owned file: a write must fail with EROFS, rather than mere directory permissions.
  await assert.rejects(writeFile("/app/README.md", "must not write", { flag: "a" }), { code: "EROFS" });
  await writeFile("/tmp/boushun-acceptance-exec", "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o700 });
  try {
    assert.equal(await readFile("/tmp/boushun-acceptance-exec", "utf8"), "#!/bin/sh\nexit 0\n");
    await assert.rejects(run("/tmp/boushun-acceptance-exec"), { code: "EACCES" });
  } finally {
    await unlink("/tmp/boushun-acceptance-exec");
  }
} else if (phase === "after") {
  assert.deepEqual(state.layout, positions);
  assert.deepEqual((await api("database/export")).state, JSON.parse(await readFile("/data/acceptance-baseline.json", "utf8")));
} else {
  throw new Error("Expected before or after phase");
}
console.log(`Container ${phase}: collection, storage and runtime boundaries passed`);
