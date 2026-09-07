export const EXPORTS = Object.freeze({
  json: Object.freeze({ route: "/api/export", fileName: "boushun-demo.json" }),
  inventory: Object.freeze({ route: "/api/export/inventory.csv", fileName: "boushun-inventory.csv" }),
  ports: Object.freeze({ route: "/api/export/ports.csv", fileName: "boushun-open-ports.csv" }),
});

const readOnlyMessage = "Static demo is read-only. This action is available in a local Boushun installation.";
const capabilities = (enabled) => Object.freeze({
  collect: enabled,
  editIdentity: enabled,
  editInterfaces: enabled,
  automation: enabled,
  manageDatabase: enabled,
});

export function createLiveRuntime({ fetch: fetcher = globalThis.fetch } = {}) {
  async function request(route, options = {}) {
    const requestOptions = { ...options, headers: { ...(options.headers ?? {}) } };
    if (options.body !== undefined) {
      requestOptions.headers["content-type"] = "application/json";
      requestOptions.body = JSON.stringify(options.body);
    }
    const response = await fetcher(route, requestOptions);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  return Object.freeze({
    kind: "live",
    capabilities: capabilities(true),
    request,
    saveLayout: (positions) => request("/api/layout", { method: "PUT", body: { positions } }),
    exportTarget(kind) {
      if (kind === "database") return { href: "/api/database/export" };
      return { href: exportDefinition(kind).route };
    },
  });
}

export function createStaticRuntime({ baseURL, fetch: fetcher = globalThis.fetch, timeoutMs = 15_000 }) {
  const fixtureURL = new URL("./demo-fixture.json", baseURL);
  let fixturePromise;
  async function loadFixture() {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("Static demo data timed out. Reload the page to try again."));
    }, timeoutMs);
    try {
      const response = await fetcher(fixtureURL, { signal: controller.signal });
      if (!response.ok) throw new Error(`Unable to load static demo fixture (${response.status})`);
      const fixture = await response.json();
      if (fixture?.readOnly !== true || !fixture.routes || typeof fixture.routes !== "object" || Array.isArray(fixture.routes)) {
        throw new Error("Invalid static demo fixture");
      }
      return fixture;
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return Object.freeze({
    kind: "static",
    capabilities: capabilities(false),
    async request(route, options = {}) {
      if (String(options.method ?? "GET").toUpperCase() !== "GET") throw new Error(readOnlyMessage);
      if (typeof route !== "string" || !route.startsWith("/api/")) throw new Error("Demo endpoint not available");
      // Share one bounded load, including failures until an explicit page reload.
      // Each caller receives an independent API response.
      const fixture = await (fixturePromise ??= loadFixture());
      if (!Object.hasOwn(fixture.routes, route)) throw new Error("Demo endpoint not available");
      return structuredClone(fixture.routes[route]);
    },
    // Map movement is session-local in the static UI, never a simulated API write.
    saveLayout: async () => ({ saved: false, demo: true }),
    exportTarget(kind) {
      if (kind === "database") throw new Error(readOnlyMessage);
      const { fileName } = exportDefinition(kind);
      return { href: new URL(`./${fileName}`, baseURL).href, fileName };
    },
  });
}

function exportDefinition(kind) {
  if (!Object.hasOwn(EXPORTS, kind)) throw new Error("Unknown export format");
  return EXPORTS[kind];
}
