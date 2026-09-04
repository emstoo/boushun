import { createHash } from "node:crypto";
import net from "node:net";
import { assertSafeScanCIDR, hostAddresses } from "../domain/ipv4.js";

const MAX_PORTS = 64;
const MAX_ATTEMPTS = 16_384;

const PRESETS = Object.freeze({
  "lan-common": Object.freeze({
    label: "LAN common",
    description: "Common administration, file, camera, messaging, and printing services",
    ports: Object.freeze([22, 53, 80, 443, 445, 554, 631, 1883, 8000, 8080, 8443, 9100]),
  }),
  web: Object.freeze({
    label: "Web interfaces",
    description: "Common HTTP and HTTPS administration ports",
    ports: Object.freeze([80, 443, 3000, 5000, 8000, 8080, 8443]),
  }),
  kubernetes: Object.freeze({
    label: "Kubernetes",
    description: "Kubernetes API, kubelet, and NodePorts observed through the Kubernetes API",
    ports: Object.freeze([6443, 10250]),
  }),
  custom: Object.freeze({
    label: "Custom only",
    description: "Scan only the custom ports entered for this run",
    ports: Object.freeze([]),
  }),
});

export function tcpServicePresets(snapshot = null) {
  return Object.entries(PRESETS).map(([id, preset]) => {
    const ports = id === "kubernetes"
      ? uniquePorts([...preset.ports, ...kubernetesNodePorts(snapshot)])
      : [...preset.ports];
    return { id, label: preset.label, description: preset.description, ports };
  });
}

export function resolveTcpServicePorts(presetId, customPorts, snapshot = null) {
  const preset = tcpServicePresets(snapshot).find((item) => item.id === (presetId || "lan-common"));
  if (!preset) throw validationError("Unknown TCP service preset");
  const ports = uniquePorts([...preset.ports, ...parseCustomPorts(customPorts)]);
  if (!ports.length) throw validationError("Select a preset or enter at least one custom TCP port");
  if (ports.length > MAX_PORTS) throw validationError(`A TCP service scan is limited to ${MAX_PORTS} unique ports`);
  return ports;
}

export function parseCustomPorts(input) {
  if (input === undefined || input === null || input === "") return [];
  if (String(input).length > 1_000) throw validationError("Custom TCP port input is too long");
  const tokens = Array.isArray(input) ? input.map(String) : String(input).split(",");
  const ports = [];
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!validPort(start) || !validPort(end) || end < start) throw validationError(`Invalid TCP port range: ${token}`);
      if (end - start + 1 > MAX_PORTS) throw validationError(`TCP port range is too large: ${token}`);
      for (let port = start; port <= end; port += 1) ports.push(port);
      continue;
    }
    const port = Number(token);
    if (!/^\d+$/.test(token) || !validPort(port)) throw validationError(`Invalid TCP port: ${token}`);
    ports.push(port);
  }
  return uniquePorts(ports);
}

export async function collectTcpServices(options = {}) {
  const {
    cidr,
    allowedCIDRs = [],
    ports = [],
    connector = connectTcp,
    concurrency = 64,
    timeoutMs = 900,
    signal,
    onProgress = () => {},
    observedAt = new Date().toISOString(),
  } = options;
  const safeCIDR = assertSafeScanCIDR(cidr, allowedCIDRs);
  const normalizedPorts = uniquePorts(ports.map(Number));
  if (!normalizedPorts.length || normalizedPorts.some((port) => !validPort(port))) throw validationError("At least one valid TCP port is required");
  if (normalizedPorts.length > MAX_PORTS) throw validationError(`A TCP service scan is limited to ${MAX_PORTS} unique ports`);

  // Service discovery intentionally includes the probe host. Only network and
  // broadcast addresses are excluded for ordinary IPv4 subnets.
  const targets = hostAddresses(safeCIDR);
  const attemptCount = targets.length * normalizedPorts.length;
  if (attemptCount > MAX_ATTEMPTS) throw validationError(`A TCP service scan is limited to ${MAX_ATTEMPTS} connection attempts`);

  const attempts = targets.flatMap((address) => normalizedPorts.map((port) => ({ address, port })));
  const endpoints = [];
  const outcomeCounts = { open: 0, closed: 0, "filtered-or-unreachable": 0, unreachable: 0, error: 0 };
  let cursor = 0;
  let completed = 0;
  onProgress({ phase: "tcp-services", completed: 0, total: attempts.length, message: `Checking ${targets.length} addresses across ${normalizedPorts.length} ports`, metrics: { openCount: 0 } });

  const worker = async () => {
    while (cursor < attempts.length) {
      const index = cursor;
      cursor += 1;
      throwIfAborted(signal);
      const attempt = attempts[index];
      const result = await connector(attempt.address, attempt.port, { timeoutMs, signal });
      throwIfAborted(signal);
      const state = outcomeCounts[result.state] === undefined ? "error" : result.state;
      outcomeCounts[state] += 1;
      if (state === "open") endpoints.push({
        address: attempt.address,
        port: attempt.port,
        protocol: "tcp",
        service: serviceName(attempt.port),
        latencyMs: result.latencyMs ?? null,
      });
      completed += 1;
      onProgress({ phase: "tcp-services", completed, total: attempts.length, message: `${completed}/${attempts.length} connections · ${endpoints.length} open`, metrics: { openCount: endpoints.length } });
    }
  };
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, attempts.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  endpoints.sort((a, b) => compareAddress(a.address, b.address) || a.port - b.port);
  const evidence = endpoints.map((endpoint) => evidenceRecord(observedAt, "tcp-service-open", `${endpoint.address}:${endpoint.port}/tcp accepted a connection`, endpoint));
  endpoints.forEach((endpoint, index) => { endpoint.evidenceIds = [evidence[index].id]; });
  const summaryEvidence = evidenceRecord(observedAt, "tcp-service-scan", `Checked ${attemptCount} TCP endpoints and found ${endpoints.length} open`, {
    cidr: safeCIDR.canonical,
    ports: normalizedPorts,
    targetCount: targets.length,
    attemptCount,
    openCount: endpoints.length,
    outcomeCounts,
  });
  evidence.unshift(summaryEvidence);

  return {
    cidr: safeCIDR.canonical,
    method: "tcp-connect",
    targetCount: targets.length,
    ports: normalizedPorts,
    portCount: normalizedPorts.length,
    attemptCount,
    openCount: endpoints.length,
    openHostCount: new Set(endpoints.map((item) => item.address)).size,
    outcomeCounts,
    endpoints,
    evidence,
    source: {
      id: "tcp-services",
      label: "TCP service discovery",
      configured: true,
      status: "connected",
      recordCount: endpoints.length,
      message: `${endpoints.length} open services found across ${targets.length} addresses and ${normalizedPorts.length} ports`,
    },
  };
}

export function connectTcp(address, port, { timeoutMs = 900, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const started = performance.now();
    const socket = net.createConnection({ host: address, port });
    let settled = false;
    const finish = (state, code = null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.removeAllListeners();
      socket.destroy();
      resolve({ state, code, latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) });
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(Math.max(100, Math.min(Number(timeoutMs) || 900, 5_000)));
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("filtered-or-unreachable", "ETIMEDOUT"));
    socket.once("error", (error) => finish(stateForError(error), error.code ?? null));
  });
}

function stateForError(error) {
  if (error?.code === "ECONNREFUSED") return "closed";
  if (["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN"].includes(error?.code)) return "unreachable";
  if (["ETIMEDOUT", "EACCES", "EPERM"].includes(error?.code)) return "filtered-or-unreachable";
  return "error";
}

function evidenceRecord(observedAt, type, summary, raw) {
  const digest = createHash("sha256").update(`${observedAt}\0${type}\0${summary}\0${JSON.stringify(raw)}`).digest("hex").slice(0, 16);
  return { id: `evidence:${digest}`, type, source: "tcp-connect", observedAt, summary, raw };
}

function kubernetesNodePorts(snapshot) {
  return (snapshot?.kubernetes?.services ?? []).flatMap((service) => (service.ports ?? []).map((port) => port.nodePort).filter(Boolean));
}

function serviceName(port) {
  return ({ 22: "ssh", 53: "dns", 80: "http", 443: "https", 445: "smb", 554: "rtsp", 631: "ipp", 1883: "mqtt", 3000: "web", 5000: "web", 6443: "kubernetes-api", 8000: "web", 8080: "http-alt", 8443: "https-alt", 9100: "printer", 10250: "kubelet" })[port] ?? `tcp-${port}`;
}

function uniquePorts(ports) {
  return [...new Set(ports)].sort((a, b) => a - b);
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function compareAddress(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error("Scan cancelled");
  error.name = "AbortError";
  return error;
}

function validationError(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}
