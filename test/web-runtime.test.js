import assert from "node:assert/strict";
import test from "node:test";
import { createLiveRuntime, createStaticRuntime, EXPORTS } from "../src/web/api-client.js";
import { applyCapabilities, setControlDisabled } from "../src/web/capabilities.js";

test("live runtime preserves JSON requests, errors, layout persistence and export routes", async () => {
  const calls = [];
  const runtime = createLiveRuntime({ fetch: async (route, options) => {
    calls.push({ route, options });
    return Response.json({ saved: true });
  } });
  assert.ok(Object.values(runtime.capabilities).every(Boolean));
  await runtime.request("/api/state");
  assert.equal(calls[0].options.body, undefined);
  const controller = new AbortController();
  await runtime.request("/api/settings", { method: "PUT", body: { enabled: true }, headers: { accept: "application/json" }, signal: controller.signal });
  assert.deepEqual(calls[1].options, {
    method: "PUT", body: '{"enabled":true}',
    headers: { accept: "application/json", "content-type": "application/json" }, signal: controller.signal,
  });
  assert.deepEqual(await runtime.saveLayout({ node: { x: 1, y: 2 } }), { saved: true });
  assert.equal(calls[2].route, "/api/layout");
  assert.equal(calls[2].options.body, '{"positions":{"node":{"x":1,"y":2}}}');
  for (const [kind, { route }] of Object.entries(EXPORTS)) assert.deepEqual(runtime.exportTarget(kind), { href: route });
  assert.deepEqual(runtime.exportTarget("database"), { href: "/api/database/export" });
  const failed = createLiveRuntime({ fetch: async () => Response.json({ error: "Denied" }, { status: 403 }) });
  await assert.rejects(failed.request("/api/state"), /Denied/);
});

test("static runtime fetches one subpath fixture without modifying global fetch or sharing mutable responses", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const runtime = createStaticRuntime({ baseURL: "https://example.test/boushun/", fetch: async (url) => {
    calls.push(String(url));
    return Response.json({ readOnly: true, routes: { "/api/state": { layout: {} }, "/api/history": [] } });
  } });
  assert.deepEqual(calls, []);
  const [state, history] = await Promise.all([runtime.request("/api/state"), runtime.request("/api/history")]);
  state.layout.node = { x: 1, y: 2 };
  assert.deepEqual(history, []);
  assert.deepEqual(await runtime.request("/api/state"), { layout: {} });
  assert.deepEqual(calls, ["https://example.test/boushun/demo-fixture.json"]);
  assert.equal(globalThis.fetch, originalFetch);
  assert.ok(Object.values(runtime.capabilities).every((enabled) => !enabled));
});

test("static runtime rejects all API writes but supports session-local layout without network access", async () => {
  const runtime = createStaticRuntime({ baseURL: "https://example.test/", fetch: async () => assert.fail("Unexpected fetch") });
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "put"]) {
    await assert.rejects(runtime.request("/api/layout", { method, body: { positions: {} } }), /read-only/);
  }
  assert.deepEqual(await runtime.saveLayout({ node: { x: 1, y: 2 } }), { saved: false, demo: true });
  assert.throws(() => runtime.exportTarget("database"), /read-only/);
});

test("static runtime rejects unknown and foreign endpoints without a live API fallback", async () => {
  const calls = [];
  const runtime = createStaticRuntime({ baseURL: "https://example.test/", fetch: async (url) => {
    calls.push(String(url));
    return Response.json({ readOnly: true, routes: {} });
  } });
  for (const route of ["https://foreign.test/api/state", "/elsewhere/api/state", "/api/missing", "/api/toString"]) {
    await assert.rejects(runtime.request(route), /endpoint not available/);
  }
  assert.deepEqual(calls, ["https://example.test/demo-fixture.json"]);
});

for (const [name, response, expected] of [
  ["missing", () => new Response("Missing", { status: 404 }), /fixture \(404\)/],
  ["invalid JSON", () => new Response("invalid"), SyntaxError],
  ["null", () => Response.json(null), /Invalid static demo fixture/],
  ["writable", () => Response.json({ readOnly: false, routes: {} }), /Invalid static demo fixture/],
  ["invalid routes", () => Response.json({ readOnly: true, routes: [] }), /Invalid static demo fixture/],
]) {
  test(`static runtime fails closed for ${name} fixtures`, async () => {
    const calls = [];
    const runtime = createStaticRuntime({ baseURL: "https://example.test/boushun/", fetch: async (url) => {
      calls.push(String(url));
      return response();
    } });
    await assert.rejects(runtime.request("/api/state"), expected);
    await assert.rejects(runtime.request("/api/history"), expected);
    assert.deepEqual(calls, ["https://example.test/boushun/demo-fixture.json"]);
  });
}

test("static exports use the build contract at root and project subpaths", () => {
  for (const baseURL of ["https://example.test/", "https://example.test/boushun/"]) {
    const runtime = createStaticRuntime({ baseURL });
    for (const [kind, { fileName }] of Object.entries(EXPORTS)) {
      assert.deepEqual(runtime.exportTarget(kind), { href: `${baseURL}${fileName}`, fileName });
    }
    assert.throws(() => runtime.exportTarget("toString"), /Unknown export format/);
  }
});

test("control capabilities preserve busy states and cannot be re-enabled by rendering", () => {
  const control = {
    disabled: false,
    closest: () => ({ dataset: { capability: "collect" } }),
    setAttribute(name, value) { this[name] = value; },
  };
  setControlDisabled(control, false, { collect: false });
  assert.equal(control.disabled, true);
  assert.equal(control["aria-disabled"], "true");
  setControlDisabled(control, false, { collect: false });
  assert.equal(control.disabled, true);
  setControlDisabled(control, false, {});
  assert.equal(control.disabled, true);
  setControlDisabled(control, true, { collect: true });
  assert.equal(control.disabled, true);
  setControlDisabled(control, false, { collect: true });
  assert.equal(control.disabled, false);
  control.closest = () => null;
  applyCapabilities({ querySelectorAll: () => [control] }, {});
  assert.equal(control.disabled, false);
});
