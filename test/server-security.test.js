import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { collectDemo } from "../src/collectors/demo.js";
import { createBoushunServer } from "../src/server.js";

test("[API-06] security headers cover API, static, not-found, and error responses", async (t) => {
  const { baseUrl } = await startServer(t);
  const responses = [
    await fetch(`${baseUrl}/api/state`),
    await fetch(`${baseUrl}/`),
    await fetch(`${baseUrl}/missing`),
    await fetch(`${baseUrl}/api/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
  ];
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 404, 400]);
  for (const response of responses) {
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    await response.arrayBuffer();
  }
});

test("[API-04, DB-09] malformed and oversized bodies are rejected without changing state", async (t) => {
  const { baseUrl, directory } = await startServer(t);
  const before = await (await fetch(`${baseUrl}/api/database`)).json();

  const malformed = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);

  const normalOversize = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "passive", padding: "x".repeat(64 * 1024) }),
  });
  assert.equal(normalOversize.status, 400);
  assert.match((await normalOversize.json()).error, /too large/);

  const importOversize = await fetch(`${baseUrl}/api/database/import/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ database: { version: 2, snapshots: [], padding: "x".repeat(25 * 1024 * 1024) } }),
  });
  assert.equal(importOversize.status, 400);
  assert.match((await importOversize.json()).error, /too large/);

  const after = await (await fetch(`${baseUrl}/api/database`)).json();
  assert.deepEqual(after.summary, before.summary);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("state.backup.")), []);
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
});

test("[API-05] filesystem errors expose only bounded error codes", async (t) => {
  const store = {
    async initialize() {},
    async latest() { return { id: "snapshot:existing" }; },
    async read() { throw Object.assign(new Error("EACCES at /private/boushun/state.json"), { code: "EACCES" }); },
  };
  const { server } = await createBoushunServer({ host: "127.0.0.1", port: 0, store, startScheduler: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/state`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "EACCES" });
});

test("[API-07] non-loopback binding is always rejected", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-bind-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(createBoushunServer({
    host: "0.0.0.0",
    port: 0,
    dataDirectory: directory,
    startScheduler: false,
  }), /only binds to loopback addresses/);
});

test("[API-13] request host and browser origin stay within the loopback boundary", async (t) => {
  let collectionCalls = 0;
  const { baseUrl } = await startServer(t, {
    collector: async () => {
      collectionCalls += 1;
      return collectDemo();
    },
  });
  const initialCollectionCalls = collectionCalls;

  const rejectedHost = await requestWithHost(`${baseUrl}/api/state`, "attacker.example");
  assert.equal(rejectedHost.status, 421);
  assert.deepEqual(rejectedHost.body, { error: "Request host is not allowed" });

  const malformedHost = await requestWithHost(`${baseUrl}/api/state`, "127.0.0.1/invalid");
  assert.equal(malformedHost.status, 421);
  assert.deepEqual(malformedHost.body, { error: "Request host is not allowed" });

  const rejectedOrigin = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ profile: "passive" }),
  });
  assert.equal(rejectedOrigin.status, 403);
  assert.deepEqual(await rejectedOrigin.json(), { error: "Cross-origin requests are not allowed" });
  assert.equal(collectionCalls, initialCollectionCalls);

  const sameOrigin = await fetch(`${baseUrl}/api/health`, { headers: { origin: baseUrl } });
  assert.equal(sameOrigin.status, 200);

  const localClient = await fetch(`${baseUrl}/api/health`);
  assert.equal(localClient.status, 200);
});

function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("[API-08, API-09, API-12] exports are non-cacheable, CSV-safe, and paths cannot traverse", async (t) => {
  const { baseUrl } = await startServer(t, {
    collector: async () => {
      const snapshot = collectDemo();
      snapshot.devices[0].name = "=cmd";
      return snapshot;
    },
  });

  const jsonExport = await fetch(`${baseUrl}/api/export`);
  assert.equal(jsonExport.status, 200);
  assert.match(jsonExport.headers.get("content-type"), /^application\/json/);
  assert.match(jsonExport.headers.get("content-disposition"), /^attachment;/);
  assert.equal(jsonExport.headers.get("cache-control"), "no-store");
  await jsonExport.arrayBuffer();

  const csvExport = await fetch(`${baseUrl}/api/export/inventory.csv`);
  assert.equal(csvExport.status, 200);
  assert.match(csvExport.headers.get("content-type"), /^text\/csv/);
  assert.match(csvExport.headers.get("content-disposition"), /^attachment;/);
  assert.equal(csvExport.headers.get("cache-control"), "no-store");
  const csvBytes = Buffer.from(await csvExport.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = csvBytes.toString("utf8");
  assert.match(csv, /"'=cmd"/);

  const traversal = await fetch(`${baseUrl}/%2e%2e%2fpackage.json`);
  assert.equal(traversal.status, 404);
  assert.doesNotMatch(await traversal.text(), /boushun-network-map/);
});

async function startServer(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-server-security-"));
  const { server, store } = await createBoushunServer({
    host: "127.0.0.1",
    port: 0,
    dataDirectory: directory,
    startScheduler: false,
    collector: options.collector ?? (async () => collectDemo()),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, directory, server, store };
}
