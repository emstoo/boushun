import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDemo } from "./collectors/demo.js";
import { collectNetwork } from "./collectors/network.js";
import { collectTcpServices, resolveTcpServicePorts, tcpServicePresets } from "./collectors/tcp-services.js";
import { collectUdpServices, resolveUdpServicePorts, udpServicePresets } from "./collectors/udp-services.js";
import { composeCurrentSnapshot } from "./domain/current-state.js";
import { withInventory } from "./domain/inventory.js";
import { resolveInterfacePolicy } from "./domain/interface-policy.js";
import { assertSafeScanCIDR } from "./domain/ipv4.js";
import { buildComparableServiceChanges, endpointKey } from "./domain/service-observation.js";
import { ScanManager } from "./scan/scan-manager.js";
import { ServiceScheduler } from "./scan/service-scheduler.js";
import { JsonStore } from "./store/json-store.js";
import { buildTopologyViews, diffSnapshots } from "./topology/build-topology.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.join(moduleDirectory, "web");
const defaultDataDirectory = path.resolve(moduleDirectory, "../data");
const MAX_DATABASE_IMPORT_BYTES = 25 * 1024 * 1024;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/viewport.js", ["viewport.js", "text/javascript; charset=utf-8"]],
  ["/layout.js", ["layout.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export async function createBoushunServer(options = {}) {
  const config = {
    host: options.host ?? process.env.BOUSHUN_HOST ?? "127.0.0.1",
    port: Number(options.port ?? process.env.BOUSHUN_PORT ?? 4177),
    dataDirectory: options.dataDirectory ?? process.env.BOUSHUN_DATA_DIR ?? defaultDataDirectory,
    demo: options.demo ?? process.env.BOUSHUN_DEMO === "1",
    allowedCIDRs: options.allowedCIDRs ?? splitCIDRs(process.env.BOUSHUN_ALLOWED_CIDRS),
  };

  assertBindingIsSafe(config.host);
  const store = options.store ?? new JsonStore(config.dataDirectory);
  await store.initialize();

  const collector = options.collector ?? (config.demo
    ? async () => collectDemo()
    : (collectorOptions) => collectNetwork({ ...collectorOptions, allowedCIDRs: config.allowedCIDRs, dataDirectory: config.dataDirectory }));
  const tcpServiceCollector = options.tcpServiceCollector ?? collectTcpServices;
  const udpServiceCollector = options.udpServiceCollector ?? collectUdpServices;

  if (!(await store.latest()) || config.demo) {
    const initial = await collector({ profile: "passive" });
    await store.saveSnapshot(initial);
  }

  const scans = options.scanManager ?? new ScanManager();
  let databaseMutationActive = false;
  const startServiceScan = async (protocol, body, metadata = {}) => {
    if (databaseMutationActive) throw conflictError("Database maintenance is in progress");
    const cidr = body.cidr;
    assertSafeScanCIDR(cidr, config.allowedCIDRs);
    const scanState = await store.read();
    const latest = composeCurrentSnapshot(scanState.snapshots);
    const preset = body.preset || (protocol === "tcp" ? "lan-common" : "safe-common");
    const ports = protocol === "tcp"
      ? resolveTcpServicePorts(preset, body.customPorts, latest)
      : resolveUdpServicePorts(preset, body.customPorts);
    const serviceCollector = protocol === "tcp" ? tcpServiceCollector : udpServiceCollector;
    return scans.start({
      kind: `${protocol}-services`,
      cidr,
      preset,
      ports,
      trigger: metadata.trigger ?? "manual",
      scheduleId: metadata.scheduleId ?? null,
    }, async ({ signal, onProgress }) => {
      const snapshot = await collector({ profile: "passive", signal, onProgress, settings: scanState.settings });
      const result = await serviceCollector({
        cidr,
        ports,
        allowedCIDRs: config.allowedCIDRs,
        observedAt: snapshot.observedAt,
        signal,
        onProgress,
      });
      const { evidence, source, ...services } = result;
      snapshot.profile = `${protocol}-services`;
      snapshot[`${protocol}Services`] = { ...services, preset, customPorts: body.customPorts || "" };
      snapshot.evidence.push(...evidence);
      snapshot.sources ||= [];
      snapshot.sources.push(source);
      snapshot.summary = {
        ...(snapshot.summary ?? {}),
        [`${protocol}ServiceCount`]: services.openCount,
        [`${protocol}ServiceHostCount`]: services.openHostCount,
        ...(protocol === "udp" ? { udpServiceUncertainCount: services.uncertainCount } : {}),
      };
      if (!signal.aborted) await store.saveSnapshot(snapshot);
      if (!signal.aborted && metadata.scheduleId) {
        const saved = await store.read();
        const changes = buildComparableServiceChanges(saved.snapshots, snapshot, protocol);
        if (changes.comparable && changes.added.length) {
          await store.appendPortNotifications(changes.added.map((endpoint) => ({
            fingerprint: `${metadata.scheduleId}:${snapshot.id}:${endpointKey(endpoint, protocol)}`,
            type: "new-port",
            scheduleId: metadata.scheduleId,
            snapshotId: snapshot.id,
            observedAt: snapshot.observedAt,
            protocol,
            address: endpoint.address,
            port: endpoint.port,
            service: endpoint.service ?? null,
          })));
        }
      }
      return snapshot;
    });
  };
  const runScheduledServiceScan = async (schedule) => {
    const job = await startServiceScan(schedule.protocol, schedule, { trigger: "schedule", scheduleId: schedule.id });
    const completed = await scans.wait(job.id);
    if (!completed || completed.job.status !== "completed") {
      const error = new Error(completed?.job.error || `Scheduled scan ${completed?.job.status ?? "was not found"}`);
      error.code = completed?.job.status === "cancelled" ? "SCAN_CANCELLED" : "SCAN_FAILED";
      throw error;
    }
    return completed.result;
  };
  const scheduler = options.serviceScheduler ?? new ServiceScheduler({ store, run: runScheduledServiceScan });
  if (options.startScheduler !== false) scheduler.start();
  const server = createServer(async (request, response) => {
    try {
      setSecurityHeaders(response);
      assertRequestBoundary(request, config.host);
      const url = new URL(request.url, "http://boushun.invalid");

      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { status: "ok", scanning: Boolean(scans.active()), activeScan: scans.active(), demo: config.demo });
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        const state = await store.read();
        const rawSnapshot = composeCurrentSnapshot(state.snapshots);
        const rawPrevious = composeCurrentSnapshot(state.snapshots.slice(0, -1));
        const snapshot = projectSnapshot(rawSnapshot, state);
        const previous = projectSnapshot(rawPrevious, state);
        const topologies = buildTopologyViews(snapshot, state.overrides, state.settings);
        return json(response, 200, {
          snapshot,
          inventory: snapshot?.inventory ?? null,
          topology: topologies.logical,
          topologies,
          diff: diffSnapshots(previous, snapshot, state.overrides, state.settings),
          layout: state.layout,
          scanning: Boolean(scans.active()),
          activeScan: scans.active(),
          overrides: { ...state.overrides, audit: state.overrides.audit.slice(-100) },
          settings: state.settings,
          interfaceControls: buildInterfaceControls(rawSnapshot, state.settings),
          sourceHealth: buildSourceHealth(rawSnapshot, state.snapshots),
          presence: buildPresence(state),
          tcpServicePresets: tcpServicePresets(rawSnapshot),
          tcpServiceObservation: buildTcpServiceObservation(state, snapshot),
          udpServicePresets: udpServicePresets(),
          udpServiceObservation: buildUdpServiceObservation(state, snapshot),
          serviceSchedules: state.settings.serviceSchedules,
          notifications: state.notifications.slice().reverse(),
          demo: config.demo,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/history") {
        const state = await store.read();
        return json(response, 200, state.snapshots.map((snapshot) => ({
          id: snapshot.id,
          observedAt: snapshot.observedAt,
          profile: snapshot.profile,
          summary: snapshot.summary,
          scan: snapshot.scan,
          tcpServices: snapshot.tcpServices ?? null,
          udpServices: snapshot.udpServices ?? null,
          warnings: snapshot.warnings,
        })));
      }

      const historyMatch = url.pathname.match(/^\/api\/history\/([^/]+)$/);
      if (request.method === "GET" && historyMatch) {
        const state = await store.read();
        const index = state.snapshots.findIndex((item) => item.id === decodeURIComponent(historyMatch[1]));
        if (index === -1) return json(response, 404, { error: "Snapshot not found" });
        const history = state.snapshots.slice(0, index + 1);
        const raw = composeCurrentSnapshot(history);
        const snapshot = projectSnapshot(raw, state);
        return json(response, 200, {
          snapshot,
          inventory: snapshot.inventory,
          topologies: buildTopologyViews(snapshot, state.overrides, state.settings),
          sourceHealth: buildSourceHealth(raw, history),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/compare") {
        const state = await store.read();
        const fromId = url.searchParams.get("from");
        const toId = url.searchParams.get("to");
        const fromIndex = state.snapshots.findIndex((item) => item.id === fromId);
        const toIndex = state.snapshots.findIndex((item) => item.id === toId);
        if (fromIndex === -1 || toIndex === -1) return json(response, 404, { error: "Both snapshots must exist" });
        const fromRaw = state.snapshots[fromIndex];
        const toRaw = state.snapshots[toIndex];
        const from = projectSnapshot(composeCurrentSnapshot(state.snapshots.slice(0, fromIndex + 1)), state);
        const to = projectSnapshot(composeCurrentSnapshot(state.snapshots.slice(0, toIndex + 1)), state);
        return json(response, 200, {
          from: snapshotMetadata(fromRaw),
          to: snapshotMetadata(toRaw),
          diff: diffSnapshots(from, to, state.overrides, state.settings),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/scan") {
        const body = await readJsonBody(request);
        const profile = body.profile ?? "passive";
        if (!new Set(["passive", "standard", "deep"]).has(profile)) {
          return json(response, 400, { error: "profile must be passive, standard, or deep" });
        }
        try {
          if (databaseMutationActive) throw conflictError("Database maintenance is in progress");
          const scanState = await store.read();
          const job = scans.start({ profile, cidr: body.cidr || null }, async ({ signal, onProgress }) => {
            const snapshot = await collector({ profile, cidr: body.cidr || undefined, signal, onProgress, settings: scanState.settings });
            if (!signal.aborted) await store.saveSnapshot(snapshot);
            return snapshot;
          });
          return json(response, 202, { job });
        } catch (error) {
          if (error.code === "SCAN_ACTIVE") return json(response, 409, { error: error.message, job: scans.active() });
          throw error;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/tcp-service-presets") {
        const latest = await store.latest();
        return json(response, 200, tcpServicePresets(latest));
      }

      if (request.method === "POST" && url.pathname === "/api/tcp-service-scan") {
        const body = await readJsonBody(request);
        try {
          const job = await startServiceScan("tcp", body);
          return json(response, 202, { job });
        } catch (error) {
          if (error.code === "SCAN_ACTIVE") return json(response, 409, { error: error.message, job: scans.active() });
          throw error;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/udp-service-presets") {
        return json(response, 200, udpServicePresets());
      }

      if (request.method === "POST" && url.pathname === "/api/udp-service-scan") {
        const body = await readJsonBody(request);
        try {
          const job = await startServiceScan("udp", body);
          return json(response, 202, { job });
        } catch (error) {
          if (error.code === "SCAN_ACTIVE") return json(response, 409, { error: error.message, job: scans.active() });
          throw error;
        }
      }

      const scanMatch = url.pathname.match(/^\/api\/scans\/([^/]+)$/);
      if (scanMatch && request.method === "GET") {
        const job = scans.get(decodeURIComponent(scanMatch[1]));
        return job ? json(response, 200, { job }) : json(response, 404, { error: "Scan not found" });
      }
      if (scanMatch && request.method === "DELETE") {
        const job = scans.cancel(decodeURIComponent(scanMatch[1]));
        return job ? json(response, 202, { job }) : json(response, 404, { error: "Scan not found" });
      }

      if (request.method === "GET" && url.pathname === "/api/automation") {
        const state = await store.read();
        return json(response, 200, {
          schedules: state.settings.serviceSchedules,
          notifications: state.notifications.slice().reverse(),
          activeScan: scans.active(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/database") {
        return json(response, 200, {
          summary: await store.databaseSummary(),
          maxImportBytes: MAX_DATABASE_IMPORT_BYTES,
          activeScan: scans.active(),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/database/export") {
        const database = await store.exportDatabase();
        const stamp = database.exportedAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="boushun-database-${stamp}.json"`,
          "cache-control": "no-store",
        });
        return response.end(`${JSON.stringify(database, null, 2)}\n`);
      }

      if (request.method === "POST" && url.pathname === "/api/database/import/preview") {
        const body = await readJsonBody(request, MAX_DATABASE_IMPORT_BYTES);
        return json(response, 200, { summary: await store.previewDatabaseImport(body.database ?? body) });
      }

      if (request.method === "POST" && url.pathname === "/api/database/import") {
        const body = await readJsonBody(request, MAX_DATABASE_IMPORT_BYTES);
        if (body.confirmation !== "IMPORT") throw requestError("Type IMPORT to confirm database replacement");
        if (scans.active() || databaseMutationActive) return json(response, 409, { error: "Wait for the active scan or database operation to finish", job: scans.active() });
        databaseMutationActive = true;
        try {
          return json(response, 200, await store.importDatabase(body.database));
        } finally {
          databaseMutationActive = false;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/database/reset") {
        const body = await readJsonBody(request);
        if (body.confirmation !== "RESET") throw requestError("Type RESET to confirm database reset");
        if (scans.active() || databaseMutationActive) return json(response, 409, { error: "Wait for the active scan or database operation to finish", job: scans.active() });
        databaseMutationActive = true;
        try {
          return json(response, 200, await store.resetDatabase());
        } finally {
          databaseMutationActive = false;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/schedules") {
        const body = await validateScheduleInput(await readJsonBody(request));
        return json(response, 201, await store.saveServiceSchedule(body, request.headers["x-boushun-actor"]));
      }

      const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleMatch && request.method === "PATCH") {
        const id = decodeURIComponent(scheduleMatch[1]);
        const state = await store.read();
        const existing = state.settings.serviceSchedules.find((item) => item.id === id);
        if (!existing) return json(response, 404, { error: "Schedule not found" });
        const body = await validateScheduleInput({ ...existing, ...(await readJsonBody(request)) });
        return json(response, 200, await store.updateServiceSchedule(id, body, request.headers["x-boushun-actor"]));
      }
      if (scheduleMatch && request.method === "DELETE") {
        return json(response, 200, await store.deleteServiceSchedule(decodeURIComponent(scheduleMatch[1]), request.headers["x-boushun-actor"]));
      }

      const runScheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/run$/);
      if (runScheduleMatch && request.method === "POST") {
        const id = decodeURIComponent(runScheduleMatch[1]);
        const state = await store.read();
        const schedule = state.settings.serviceSchedules.find((item) => item.id === id);
        if (!schedule) return json(response, 404, { error: "Schedule not found" });
        try {
          const job = await startServiceScan(schedule.protocol, schedule, { trigger: "schedule", scheduleId: schedule.id });
          await store.updateServiceScheduleRuntime(schedule.id, {
            lastRunAt: new Date().toISOString(),
            nextRunAt: new Date(Date.now() + schedule.intervalMinutes * 60_000).toISOString(),
            lastStatus: "running",
            lastError: null,
          });
          void scans.wait(job.id).then(async (completed) => {
            await store.updateServiceScheduleRuntime(schedule.id, {
              lastStatus: completed?.job.status === "completed" ? "completed" : completed?.job.status ?? "failed",
              lastError: completed?.job.error ?? null,
            });
          }).catch(() => {});
          return json(response, 202, { job });
        } catch (error) {
          if (error.code === "SCAN_ACTIVE") return json(response, 409, { error: error.message, job: scans.active() });
          throw error;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/notifications/read") {
        const body = await readJsonBody(request);
        return json(response, 200, { notifications: await store.markNotificationsRead(body.ids) });
      }

      if (request.method === "PUT" && url.pathname === "/api/layout") {
        const body = await readJsonBody(request);
        const layout = await store.saveLayout(body.positions);
        return json(response, 200, { layout });
      }

      const interfaceMatch = url.pathname.match(/^\/api\/settings\/interfaces\/(.+)$/);
      if (interfaceMatch && ["PUT", "PATCH"].includes(request.method)) {
        const name = decodeURIComponent(interfaceMatch[1]);
        return json(response, 200, await store.saveInterfacePolicy(name, await readJsonBody(request), request.headers["x-boushun-actor"]));
      }

      if (request.method === "GET" && url.pathname === "/api/settings") {
        return json(response, 200, (await store.read()).settings);
      }

      const overrideMatch = url.pathname.match(/^\/api\/devices\/(.+)\/override$/);
      if (overrideMatch && ["PUT", "PATCH"].includes(request.method)) {
        const id = decodeURIComponent(overrideMatch[1]);
        const body = await readJsonBody(request);
        const result = await store.saveDeviceOverride(id, body, request.headers["x-boushun-actor"]);
        return json(response, 200, result);
      }

      const recommendedSplitMatch = url.pathname.match(/^\/api\/devices\/(.+)\/recommended-split$/);
      if (recommendedSplitMatch && request.method === "POST") {
        const sourceId = decodeURIComponent(recommendedSplitMatch[1]);
        const state = await store.read();
        const snapshot = projectSnapshot(composeCurrentSnapshot(state.snapshots), state);
        const device = snapshot?.inventory?.devices?.find((item) => item.id === sourceId);
        const issue = device?.identityIssues?.find((item) => item.recommendedAction?.type === "split-addresses");
        const addresses = issue?.recommendedAction?.addresses ?? [];
        if (!addresses.length) return json(response, 409, { error: "No recommended split is available for this device" });
        const splits = addresses.map((address) => ({
          sourceId,
          targetId: `device:manual:${address}`,
          addresses: [address],
          name: address,
          role: "host",
        }));
        return json(response, 201, await store.saveSplitBatch(splits, request.headers["x-boushun-actor"]));
      }

      if (request.method === "POST" && url.pathname === "/api/overrides/merge") {
        return json(response, 201, await store.saveMerge(await readJsonBody(request), request.headers["x-boushun-actor"]));
      }

      if (request.method === "POST" && url.pathname === "/api/overrides/split") {
        return json(response, 201, await store.saveSplit(await readJsonBody(request), request.headers["x-boushun-actor"]));
      }

      if (request.method === "GET" && url.pathname === "/api/overrides") {
        const state = await store.read();
        return json(response, 200, state.overrides);
      }

      if (request.method === "GET" && url.pathname === "/api/export/inventory.csv") {
        const state = await store.read();
        const snapshot = projectSnapshot(composeCurrentSnapshot(state.snapshots), state);
        const inventory = snapshot?.inventory;
        const assignments = inventory?.ipAssignments ?? [];
        const interfaces = inventory?.interfaces ?? [];
        const rows = (inventory?.devices ?? []).map((device) => ({
          status: device.status,
          name: device.name ?? "",
          suggested_name: device.suggestedName ?? "",
          addresses: assignments.filter((item) => item.deviceId === device.id).map((item) => item.address).join("; "),
          mac: interfaces.find((item) => item.deviceId === device.id && item.mac)?.mac ?? "",
          role: device.role,
          identity_confidence: device.identityConfidence,
          identity_review: device.needsIdentityReview ? device.identityIssues.map((issue) => issue.message).join("; ") : "",
          manufacturer: device.manufacturer ?? "",
          model: device.model ?? "",
          sources: device.sourceKinds.join("; "),
        }));
        return csv(response, "boushun-inventory.csv", rows, ["status", "name", "suggested_name", "addresses", "mac", "role", "identity_confidence", "identity_review", "manufacturer", "model", "sources"]);
      }

      if (request.method === "GET" && url.pathname === "/api/export/ports.csv") {
        const state = await store.read();
        const snapshot = projectSnapshot(composeCurrentSnapshot(state.snapshots), state);
        const tcp = buildTcpServiceObservation(state, snapshot);
        const udp = buildUdpServiceObservation(state, snapshot);
        const rows = [
          ...(tcp?.endpoints ?? []).map((endpoint) => portCsvRow(endpoint, tcp)),
          ...(tcp?.closedEndpoints ?? []).map((endpoint) => portCsvRow(endpoint, tcp)),
          ...(udp?.endpoints ?? []).map((endpoint) => portCsvRow(endpoint, udp)),
          ...(udp?.closedEndpoints ?? []).map((endpoint) => portCsvRow(endpoint, udp)),
          ...(udp?.uncertainEndpoints ?? []).map((endpoint) => portCsvRow(endpoint, udp)),
        ];
        return csv(response, "boushun-open-ports.csv", rows, ["address", "port", "protocol", "state", "service", "device", "observed_at", "coverage", "change", "latency_ms"]);
      }

      if (request.method === "GET" && url.pathname === "/api/export") {
        const state = await store.read();
        const rawSnapshot = composeCurrentSnapshot(state.snapshots);
        const snapshot = projectSnapshot(rawSnapshot, state);
        const topologies = buildTopologyViews(snapshot, state.overrides, state.settings);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="boushun-${snapshot?.id ?? "empty"}.json"`,
          "cache-control": "no-store",
        });
        return response.end(`${JSON.stringify({ snapshot, inventory: snapshot?.inventory, topologies, overrides: state.overrides, settings: state.settings, notifications: state.notifications, sourceHealth: buildSourceHealth(rawSnapshot, state.snapshots), presence: buildPresence(state), tcpServiceObservation: buildTcpServiceObservation(state, snapshot), udpServiceObservation: buildUdpServiceObservation(state, snapshot) }, null, 2)}\n`);
      }

      if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
        const [fileName, contentType] = STATIC_FILES.get(url.pathname);
        const contents = await readFile(path.join(webDirectory, fileName));
        response.writeHead(200, {
          "content-type": contentType,
          "cache-control": fileName === "index.html" ? "no-store" : "public, max-age=300",
        });
        return response.end(contents);
      }

      return json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = ["BAD_JSON", "BODY_TOO_LARGE", "BAD_REQUEST"].includes(error.code)
        ? 400
        : error.code === "ORIGIN_FORBIDDEN"
          ? 403
          : error.code === "NOT_FOUND"
            ? 404
            : error.code === "CONFLICT"
              ? 409
              : error.code === "HOST_NOT_ALLOWED"
                ? 421
                : 500;
      return json(response, status, { error: safeErrorMessage(error) });
    }
  });

  server.once("close", () => scheduler.stop());
  return { server, config, store, scheduler };

  async function validateScheduleInput(input) {
    if (!new Set(["tcp", "udp"]).has(input.protocol)) throw requestError("Schedule protocol must be tcp or udp");
    assertSafeScanCIDR(input.cidr, config.allowedCIDRs);
    const state = await store.read();
    const latest = composeCurrentSnapshot(state.snapshots);
    if (input.protocol === "tcp") resolveTcpServicePorts(input.preset || "lan-common", input.customPorts, latest);
    else resolveUdpServicePorts(input.preset || "safe-common", input.customPorts);
    const intervalMinutes = Number(input.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 10_080) {
      throw requestError("Schedule interval must be between 15 and 10080 minutes");
    }
    return {
      protocol: input.protocol,
      enabled: input.enabled !== false,
      cidr: input.cidr,
      preset: input.preset || (input.protocol === "tcp" ? "lan-common" : "safe-common"),
      customPorts: input.customPorts || "",
      intervalMinutes,
    };
  }
}

export async function start() {
  const { server, config } = await createBoushunServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  console.log(`Boushun is listening on http://${config.host}:${address.port}`);
  console.log(config.demo ? "Demo mode: synthetic evidence is being displayed." : "Live mode: startup collection is passive only.");

  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function csv(response, fileName, rows, columns = rows.length ? Object.keys(rows[0]) : []) {
  const contents = [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${fileName}"`,
    "cache-control": "no-store",
  });
  response.end(`\ufeff${contents}${contents ? "\n" : ""}`);
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body is too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    const error = new Error("Request body is not valid JSON");
    error.code = "BAD_JSON";
    throw error;
  }
}

function conflictError(message) {
  const error = new Error(message);
  error.code = "CONFLICT";
  return error;
}

function assertBindingIsSafe(host) {
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopback.has(host)) {
    throw new Error("Boushun only binds to loopback addresses");
  }
}

function assertRequestBoundary(request, configuredHost) {
  const authority = parseHttpAuthority(request.headers.host);
  const localPort = Number(request.socket.localPort);
  const allowedHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  for (const value of [configuredHost, request.socket.localAddress]) {
    const host = normalizeHostname(value);
    if (host && !new Set(["0.0.0.0", "::"]).has(host)) allowedHosts.add(host);
  }

  if (!authority || authority.port !== localPort || !allowedHosts.has(authority.hostname)) {
    throw boundaryError("Request host is not allowed", "HOST_NOT_ALLOWED");
  }

  const origin = request.headers.origin;
  if (origin === undefined) return;

  const parsedOrigin = parseHttpOrigin(origin);
  if (!parsedOrigin || parsedOrigin.hostname !== authority.hostname || parsedOrigin.port !== authority.port) {
    throw boundaryError("Cross-origin requests are not allowed", "ORIGIN_FORBIDDEN");
  }
}

function parseHttpAuthority(value) {
  if (typeof value !== "string" || value.length > 255 || /[\s,]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return { hostname: normalizeHostname(parsed.hostname), port: Number(parsed.port || 80) };
  } catch {
    return null;
  }
}

function parseHttpOrigin(value) {
  if (typeof value !== "string" || value.length > 512 || value === "null") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return { hostname: normalizeHostname(parsed.hostname), port: Number(parsed.port || 80) };
  } catch {
    return null;
  }
}

function normalizeHostname(value) {
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "") || null;
}

function boundaryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function splitCIDRs(value) {
  return typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function safeErrorMessage(error) {
  if (error?.code && ["ENOENT", "EACCES", "EPERM"].includes(error.code)) return error.code;
  return String(error?.message ?? "Unexpected error").slice(0, 500);
}

function requestError(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}

function projectSnapshot(snapshot, state) {
  return withInventory(snapshot, state.overrides, state.settings);
}

function snapshotMetadata(snapshot) {
  return {
    id: snapshot.id,
    observedAt: snapshot.observedAt,
    profile: snapshot.profile,
    summary: snapshot.summary,
    scan: snapshot.scan,
    tcpServices: snapshot.tcpServices ?? null,
    udpServices: snapshot.udpServices ?? null,
    warningCount: snapshot.warnings?.length ?? 0,
  };
}

function buildPresence(state) {
  const presence = {};
  for (const raw of state.snapshots) {
    const snapshot = projectSnapshot(raw, state);
    for (const device of snapshot?.inventory?.devices ?? []) {
      const record = presence[device.id] ?? {
        firstSeenAt: raw.observedAt,
        lastSeenAt: raw.observedAt,
        observationCount: 0,
        currentlyObserved: false,
      };
      if (raw.observedAt < record.firstSeenAt) record.firstSeenAt = raw.observedAt;
      if (raw.observedAt > record.lastSeenAt) record.lastSeenAt = raw.observedAt;
      record.observationCount += 1;
      presence[device.id] = record;
    }
  }
  const currentIds = new Set(projectSnapshot(composeCurrentSnapshot(state.snapshots), state)?.inventory?.devices.map((item) => item.id) ?? []);
  for (const [id, record] of Object.entries(presence)) record.currentlyObserved = currentIds.has(id);
  return presence;
}

const SOURCE_CATALOG = [
  ["local-network", "Local network facts"],
  ["dns-config", "DNS configuration"],
  ["dhcp-leases", "DHCP leases"],
  ["icmp", "ICMP discovery"],
  ["tcp-services", "TCP service discovery"],
  ["udp-services", "UDP service discovery"],
  ["kubernetes", "Kubernetes API"],
  ["controller-exports", "Controller exports"],
  ["oui-database", "OUI vendor database"],
  ["mdns", "mDNS discovery"],
  ["ssdp", "SSDP discovery"],
  ["snmpv3", "SNMPv3 topology"],
];

function buildSourceHealth(latest, snapshots) {
  const current = new Map((latest?.sources ?? []).map((item) => [item.id, item]));
  return SOURCE_CATALOG.map(([id, label]) => {
    const source = current.get(id) ?? {
      id,
      label,
      configured: ["tcp-services", "udp-services"].includes(id),
      status: "not-run",
      recordCount: 0,
      message: id === "tcp-services"
        ? "TCP service discovery has not been run"
        : id === "udp-services"
          ? "UDP service discovery has not been run"
          : "No source status was recorded in this snapshot",
    };
    const lastSuccessfulAt = [...snapshots].reverse().find((snapshot) =>
      snapshot.sources?.some((item) => item.id === id && ["connected", "degraded"].includes(item.status))
      || legacySourceSucceeded(snapshot, id))?.observedAt ?? null;
    return {
      ...source,
      lastObservedAt: source.observedAt ?? (source.snapshotId
        ? snapshots.find((snapshot) => snapshot.id === source.snapshotId)?.observedAt ?? null
        : null),
      lastSuccessfulAt,
    };
  });
}

function legacySourceSucceeded(snapshot, id) {
  if (id === "icmp") return snapshot.scan?.method === "icmp-echo";
  if (id === "tcp-services") return snapshot.tcpServices?.method === "tcp-connect";
  if (id === "udp-services") return snapshot.udpServices?.method === "udp-probe";
  if (id === "kubernetes") return snapshot.kubernetes?.available === true;
  if (id === "mdns") return (snapshot.discovery?.mdns?.length ?? 0) > 0;
  if (id === "ssdp") return (snapshot.discovery?.ssdp?.length ?? 0) > 0;
  if (id === "snmpv3") return (snapshot.snmp?.observations?.length ?? 0) > 0;
  return false;
}

function buildInterfaceControls(snapshot, settings) {
  const interfaces = new Map();
  for (const item of snapshot?.interfaces ?? []) {
    interfaces.set(item.name, {
      name: item.name,
      state: item.state ?? "UNKNOWN",
      addresses: (item.addresses ?? []).map((address) => address.address),
      observedDeviceCount: 0,
    });
  }
  for (const device of snapshot?.devices ?? []) {
    if (!device.interface) continue;
    const item = interfaces.get(device.interface) ?? { name: device.interface, state: "UNKNOWN", addresses: [], observedDeviceCount: 0 };
    item.observedDeviceCount += 1;
    interfaces.set(device.interface, item);
  }
  return [...interfaces.values()].map((item) => ({
    ...item,
    policy: resolveInterfacePolicy(item.name, item.state, settings),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function buildTcpServiceObservation(state, currentSnapshot = null) {
  const raw = [...state.snapshots].reverse().find((snapshot) => snapshot.tcpServices?.method === "tcp-connect");
  if (!raw) return null;
  const projected = currentSnapshot ?? projectSnapshot(composeCurrentSnapshot(state.snapshots), state);
  const inventory = projected.inventory;
  const assignments = new Map(inventory.ipAssignments.map((item) => [item.address, item]));
  const devices = new Map(inventory.devices.map((item) => [item.id, item]));
  const enrich = (endpoint) => {
    const assignment = assignments.get(endpoint.address);
    const device = assignment?.deviceId ? devices.get(assignment.deviceId) : null;
    return {
      ...endpoint,
      protocol: "tcp",
      deviceId: device?.id ?? null,
      deviceName: device?.name ?? device?.suggestedName ?? null,
      deviceRole: device?.role ?? null,
    };
  };
  const changes = buildComparableServiceChanges(state.snapshots, raw, "tcp");
  const added = new Set(changes.added.map((endpoint) => endpointKey(endpoint, "tcp")));
  const closedEndpoints = changes.removed.map((endpoint) => ({
    ...enrich(endpoint),
    state: "not-open",
    observedAt: raw.observedAt,
    lastObservedAt: changes.previousObservedAt,
    change: "not-open",
  }));
  return {
    snapshotId: raw.id,
    observedAt: raw.observedAt,
    result: raw.tcpServices,
    coverage: serviceCoverage(raw, raw.tcpServices),
    changes: {
      ...changes,
      added: changes.added.map(enrich),
      removed: changes.removed.map(enrich),
    },
    endpoints: (raw.tcpServices.endpoints ?? []).map((endpoint) => ({
      ...enrich(endpoint),
      observedAt: raw.observedAt,
      change: changes.comparable ? (added.has(endpointKey(endpoint, "tcp")) ? "new" : "unchanged") : "baseline",
    })),
    closedEndpoints,
  };
}

function buildUdpServiceObservation(state, currentSnapshot = null) {
  const raw = [...state.snapshots].reverse().find((snapshot) => snapshot.udpServices?.method === "udp-probe");
  if (!raw) return null;
  const projected = currentSnapshot ?? projectSnapshot(composeCurrentSnapshot(state.snapshots), state);
  const inventory = projected.inventory;
  const assignments = new Map(inventory.ipAssignments.map((item) => [item.address, item]));
  const devices = new Map(inventory.devices.map((item) => [item.id, item]));
  const enrich = (endpoint) => {
    const assignment = assignments.get(endpoint.address);
    const device = assignment?.deviceId ? devices.get(assignment.deviceId) : null;
    return {
      ...endpoint,
      protocol: "udp",
      deviceId: device?.id ?? null,
      deviceName: device?.name ?? device?.suggestedName ?? null,
      deviceRole: device?.role ?? null,
    };
  };
  const changes = buildComparableServiceChanges(state.snapshots, raw, "udp");
  const added = new Set(changes.added.map((endpoint) => endpointKey(endpoint, "udp")));
  const uncertainKeys = new Set((raw.udpServices.uncertainEndpoints ?? []).map((endpoint) => endpointKey(endpoint, "udp")));
  const closedEndpoints = changes.removed.map((endpoint) => ({
    ...enrich(endpoint),
    state: "not-confirmed",
    observedAt: raw.observedAt,
    lastObservedAt: changes.previousObservedAt,
    change: "lost-confirmation",
  })).filter((endpoint) => !uncertainKeys.has(endpointKey(endpoint, "udp")));
  const removed = new Set(changes.removed.map((endpoint) => endpointKey(endpoint, "udp")));
  return {
    snapshotId: raw.id,
    observedAt: raw.observedAt,
    result: raw.udpServices,
    coverage: serviceCoverage(raw, raw.udpServices),
    changes: {
      ...changes,
      added: changes.added.map(enrich),
      removed: changes.removed.map(enrich),
    },
    endpoints: (raw.udpServices.endpoints ?? []).map((endpoint) => ({
      ...enrich(endpoint),
      observedAt: raw.observedAt,
      change: changes.comparable ? (added.has(endpointKey(endpoint, "udp")) ? "new" : "unchanged") : "baseline",
    })),
    closedEndpoints,
    uncertainEndpoints: (raw.udpServices.uncertainEndpoints ?? []).map((endpoint) => ({
      ...enrich(endpoint),
      observedAt: raw.observedAt,
      change: removed.has(endpointKey(endpoint, "udp")) ? "lost-confirmation" : "uncertain",
    })),
  };
}

function serviceCoverage(snapshot, result) {
  return {
    snapshotId: snapshot.id,
    observedAt: snapshot.observedAt,
    cidr: result.cidr,
    targetCount: result.targetCount,
    ports: result.ports ?? [],
    portCount: result.portCount ?? result.ports?.length ?? 0,
    attemptCount: result.attemptCount,
    preset: result.preset ?? null,
    customPorts: result.customPorts ?? "",
    completed: true,
  };
}

function portCsvRow(endpoint, observation) {
  return {
    address: endpoint.address,
    port: endpoint.port,
    protocol: endpoint.protocol,
    state: endpoint.state ?? "open",
    service: endpoint.service ?? "",
    device: endpoint.deviceName ?? endpoint.deviceRole ?? "",
    observed_at: endpoint.observedAt ?? observation.observedAt,
    coverage: observation.coverage?.cidr ?? "",
    change: endpoint.change ?? "",
    latency_ms: endpoint.latencyMs ?? "",
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
