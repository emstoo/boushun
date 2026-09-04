import { createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { assertSafeScanCIDR, hostAddresses } from "../domain/ipv4.js";

const MAX_PORTS = 16;
const MAX_ATTEMPTS = 4_096;
const EXCLUDED_PORTS = new Map([
  [67, "DHCP discovery is intentionally not sent by the UDP range scanner"],
  [68, "DHCP discovery is intentionally not sent by the UDP range scanner"],
  [161, "Use configured SNMPv3 targets instead of the UDP range scanner"],
  [162, "Use configured SNMPv3 targets instead of the UDP range scanner"],
  [3702, "WS-Discovery belongs to multicast discovery rather than range scanning"],
  [5353, "mDNS belongs to multicast discovery rather than range scanning"],
]);

const PRESETS = Object.freeze({
  "safe-common": Object.freeze({
    label: "Safe common",
    description: "Read-only DNS, NTP, and NetBIOS name-service probes",
    ports: Object.freeze([53, 123, 137]),
  }),
  iot: Object.freeze({
    label: "IoT discovery",
    description: "Read-only SSDP and CoAP discovery probes",
    ports: Object.freeze([1900, 5683]),
  }),
  custom: Object.freeze({
    label: "Custom only",
    description: "Send an empty UDP datagram to only the custom ports entered for this run",
    ports: Object.freeze([]),
  }),
});

export function udpServicePresets() {
  return Object.entries(PRESETS).map(([id, preset]) => ({
    id,
    label: preset.label,
    description: preset.description,
    ports: [...preset.ports],
  }));
}

export function resolveUdpServicePorts(presetId, customPorts) {
  const preset = udpServicePresets().find((item) => item.id === (presetId || "safe-common"));
  if (!preset) throw validationError("Unknown UDP service preset");
  const ports = uniquePorts([...preset.ports, ...parseCustomUdpPorts(customPorts)]);
  if (!ports.length) throw validationError("Select a preset or enter at least one custom UDP port");
  if (ports.length > MAX_PORTS) throw validationError(`A UDP service scan is limited to ${MAX_PORTS} unique ports`);
  assertAllowedUdpPorts(ports);
  return ports;
}

export function parseCustomUdpPorts(input) {
  if (input === undefined || input === null || input === "") return [];
  if (String(input).length > 1_000) throw validationError("Custom UDP port input is too long");
  const tokens = Array.isArray(input) ? input.map(String) : String(input).split(",");
  const ports = [];
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!validPort(start) || !validPort(end) || end < start) throw validationError(`Invalid UDP port range: ${token}`);
      if (end - start + 1 > MAX_PORTS) throw validationError(`UDP port range is too large: ${token}`);
      for (let port = start; port <= end; port += 1) ports.push(port);
      continue;
    }
    const port = Number(token);
    if (!/^\d+$/.test(token) || !validPort(port)) throw validationError(`Invalid UDP port: ${token}`);
    ports.push(port);
  }
  return uniquePorts(ports);
}

export async function collectUdpServices(options = {}) {
  const {
    cidr,
    allowedCIDRs = [],
    ports = [],
    prober = probeUdp,
    concurrency = 32,
    rateLimitPerSecond = 50,
    timeoutMs = 1_500,
    retryCount = 1,
    retryDelayMs = 1_500,
    signal,
    onProgress = () => {},
    observedAt = new Date().toISOString(),
  } = options;
  const safeCIDR = assertSafeScanCIDR(cidr, allowedCIDRs);
  const normalizedPorts = uniquePorts(ports.map(Number));
  if (!normalizedPorts.length || normalizedPorts.some((port) => !validPort(port))) throw validationError("At least one valid UDP port is required");
  if (normalizedPorts.length > MAX_PORTS) throw validationError(`A UDP service scan is limited to ${MAX_PORTS} unique ports`);
  assertAllowedUdpPorts(normalizedPorts);

  const targets = hostAddresses(safeCIDR);
  const attemptCount = targets.length * normalizedPorts.length;
  if (attemptCount > MAX_ATTEMPTS) throw validationError(`A UDP service scan is limited to ${MAX_ATTEMPTS} address-port checks`);

  const endpoints = [];
  const uncertainEndpoints = [];
  const outcomeCounts = { open: 0, closed: 0, "open-or-filtered": 0, unreachable: 0, error: 0 };
  const waitForPermit = createPacer(rateLimitPerSecond);
  let targetCursor = 0;
  let completed = 0;
  let transmissionCount = 0;
  onProgress({ phase: "udp-services", completed: 0, total: attemptCount, message: `Checking ${targets.length} addresses across ${normalizedPorts.length} UDP ports`, metrics: { confirmedOpen: 0, uncertain: 0, transmissions: 0 } });

  const scanEndpoint = async (address, port) => {
    const descriptor = udpProbeForPort(port, address);
    let result = null;
    let probesSent = 0;
    const retries = Math.max(0, Math.min(1, Number(retryCount) || 0));
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      throwIfAborted(signal);
      if (attempt > 0) await abortableDelay(retryDelayMs + Math.floor(Math.random() * 251), signal);
      await waitForPermit(signal);
      probesSent += 1;
      transmissionCount += 1;
      result = await prober(address, port, { descriptor, timeoutMs, signal });
      throwIfAborted(signal);
      if (result.state !== "open-or-filtered") break;
    }
    return { ...result, descriptor, probesSent };
  };

  const worker = async () => {
    while (targetCursor < targets.length) {
      const targetIndex = targetCursor;
      targetCursor += 1;
      const address = targets[targetIndex];
      for (const port of normalizedPorts) {
        const result = await scanEndpoint(address, port);
        const state = outcomeCounts[result.state] === undefined ? "error" : result.state;
        outcomeCounts[state] += 1;
        const base = {
          address,
          port,
          protocol: "udp",
          state,
          service: result.identifiedService ? result.descriptor.service : serviceName(port),
          serviceConfidence: result.identifiedService ? "verified" : "inferred",
          probe: result.descriptor.id,
          latencyMs: result.latencyMs ?? null,
          probesSent: result.probesSent,
        };
        if (state === "open") endpoints.push({
          ...base,
          responseBytes: result.responseBytes ?? null,
          responsePreviewHex: result.responsePreviewHex ?? null,
        });
        if (state === "open-or-filtered") uncertainEndpoints.push(base);
        completed += 1;
        onProgress({ phase: "udp-services", completed, total: attemptCount, message: `${completed}/${attemptCount} checks · ${endpoints.length} confirmed open · ${uncertainEndpoints.length} uncertain`, metrics: { confirmedOpen: endpoints.length, uncertain: uncertainEndpoints.length, transmissions: transmissionCount } });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(32, Number(concurrency) || 1, targets.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  endpoints.sort(compareEndpoint);
  uncertainEndpoints.sort(compareEndpoint);
  const evidence = endpoints.map((endpoint) => evidenceRecord(observedAt, "udp-service-open", `${endpoint.address}:${endpoint.port}/udp returned a datagram`, endpoint));
  endpoints.forEach((endpoint, index) => { endpoint.evidenceIds = [evidence[index].id]; });
  const summaryEvidence = evidenceRecord(observedAt, "udp-service-scan", `Checked ${attemptCount} UDP endpoints and confirmed ${endpoints.length} open`, {
    cidr: safeCIDR.canonical,
    ports: normalizedPorts,
    targetCount: targets.length,
    attemptCount,
    transmissionCount,
    openCount: endpoints.length,
    uncertainCount: uncertainEndpoints.length,
    outcomeCounts,
  });
  evidence.unshift(summaryEvidence);
  uncertainEndpoints.forEach((endpoint) => { endpoint.evidenceIds = [summaryEvidence.id]; });

  return {
    cidr: safeCIDR.canonical,
    method: "udp-probe",
    targetCount: targets.length,
    ports: normalizedPorts,
    portCount: normalizedPorts.length,
    attemptCount,
    transmissionCount,
    openCount: endpoints.length,
    openHostCount: new Set(endpoints.map((item) => item.address)).size,
    uncertainCount: uncertainEndpoints.length,
    outcomeCounts,
    endpoints,
    uncertainEndpoints,
    evidence,
    source: {
      id: "udp-services",
      label: "UDP service discovery",
      configured: true,
      status: "connected",
      recordCount: endpoints.length,
      message: `${endpoints.length} confirmed open and ${uncertainEndpoints.length} open or filtered across ${targets.length} addresses`,
    },
  };
}

export function probeUdp(address, port, { descriptor = udpProbeForPort(port, address), timeoutMs = 1_500, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const socket = dgram.createSocket("udp4");
    const started = performance.now();
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeAllListeners();
      try { socket.close(); } catch {}
      resolve({ ...result, latencyMs: Math.max(0, Math.round((performance.now() - started) * 10) / 10) });
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      try { socket.close(); } catch {}
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => finish({ state: stateForError(error), code: error.code ?? null, identifiedService: false }));
    socket.once("message", (message) => finish({
      state: "open",
      identifiedService: descriptor.validate(message),
      responseBytes: message.length,
      responsePreviewHex: message.subarray(0, 128).toString("hex"),
    }));
    socket.connect(port, address, () => {
      if (settled) return;
      socket.send(descriptor.payload, (error) => {
        if (error) return finish({ state: stateForError(error), code: error.code ?? null, identifiedService: false });
        timer = setTimeout(() => finish({ state: "open-or-filtered", code: "ETIMEDOUT", identifiedService: false }), Math.max(250, Math.min(Number(timeoutMs) || 1_500, 10_000)));
      });
    });
  });
}

export function udpProbeForPort(port, address = "127.0.0.1") {
  if (port === 53) return dnsProbe();
  if (port === 123) return ntpProbe();
  if (port === 137) return netbiosProbe();
  if (port === 1900) return ssdpProbe(address);
  if (port === 5683) return coapProbe();
  return { id: "empty", service: `udp-${port}`, payload: Buffer.alloc(0), validate: () => false };
}

function dnsProbe() {
  const transactionId = randomBytes(2).readUInt16BE(0);
  const payload = Buffer.alloc(17);
  payload.writeUInt16BE(transactionId, 0);
  payload.writeUInt16BE(1, 4);
  payload[12] = 0;
  payload.writeUInt16BE(2, 13);
  payload.writeUInt16BE(1, 15);
  return {
    id: "dns-root-ns",
    service: "dns",
    payload,
    validate: (message) => message.length >= 12 && message.readUInt16BE(0) === transactionId && Boolean(message[2] & 0x80),
  };
}

function ntpProbe() {
  const payload = Buffer.alloc(48);
  payload[0] = 0x23;
  return {
    id: "ntp-client",
    service: "ntp",
    payload,
    validate: (message) => message.length >= 48 && [4, 5].includes(message[0] & 0x07),
  };
}

function netbiosProbe() {
  const transactionId = randomBytes(2).readUInt16BE(0);
  const payload = Buffer.alloc(50);
  payload.writeUInt16BE(transactionId, 0);
  payload.writeUInt16BE(1, 4);
  payload[12] = 32;
  const name = Buffer.alloc(16);
  name[0] = 0x2a;
  for (let index = 0; index < name.length; index += 1) {
    payload[13 + index * 2] = 0x41 + (name[index] >> 4);
    payload[14 + index * 2] = 0x41 + (name[index] & 0x0f);
  }
  payload[45] = 0;
  payload.writeUInt16BE(0x21, 46);
  payload.writeUInt16BE(1, 48);
  return {
    id: "netbios-node-status",
    service: "netbios-ns",
    payload,
    validate: (message) => message.length >= 12 && message.readUInt16BE(0) === transactionId && Boolean(message[2] & 0x80),
  };
}

function ssdpProbe(address) {
  const payload = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n`);
  return {
    id: "ssdp-m-search",
    service: "ssdp",
    payload,
    validate: (message) => /^HTTP\/1\.[01] 200\b/i.test(message.subarray(0, 64).toString("ascii")),
    target: address,
  };
}

function coapProbe() {
  const messageId = randomBytes(2).readUInt16BE(0);
  const payload = Buffer.concat([
    Buffer.from([0x40, 0x01, messageId >> 8, messageId & 0xff, 0xbb]),
    Buffer.from(".well-known"),
    Buffer.from([0x04]),
    Buffer.from("core"),
  ]);
  return {
    id: "coap-well-known-core",
    service: "coap",
    payload,
    validate: (message) => message.length >= 4 && (message[0] >> 6) === 1 && message[1] !== 0,
  };
}

export function createPacer(rateLimitPerSecond, options = {}) {
  const now = options.now ?? (() => performance.now());
  const delay = options.delay ?? abortableDelay;
  const interval = 1_000 / Math.max(1, Math.min(Number(rateLimitPerSecond) || 1, 50));
  let nextPermitAt = now();
  return async (signal) => {
    const current = now();
    const permitAt = Math.max(current, nextPermitAt);
    nextPermitAt = permitAt + interval;
    await delay(permitAt - current, signal);
  };
}

function stateForError(error) {
  if (error?.code === "ECONNREFUSED") return "closed";
  if (["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN"].includes(error?.code)) return "unreachable";
  return "error";
}

function serviceName(port) {
  return ({ 53: "dns", 123: "ntp", 137: "netbios-ns", 1900: "ssdp", 5683: "coap" })[port] ?? `udp-${port}`;
}

function evidenceRecord(observedAt, type, summary, raw) {
  const digest = createHash("sha256").update(`${observedAt}\0${type}\0${summary}\0${JSON.stringify(raw)}`).digest("hex").slice(0, 16);
  return { id: `evidence:${digest}`, type, source: "udp-probe", observedAt, summary, raw };
}

function uniquePorts(ports) {
  return [...new Set(ports)].sort((a, b) => a - b);
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function assertAllowedUdpPorts(ports) {
  for (const port of ports) {
    const reason = EXCLUDED_PORTS.get(port);
    if (reason) throw validationError(`UDP port ${port} is excluded: ${reason}`);
  }
}

function compareEndpoint(a, b) {
  return compareAddress(a.address, b.address) || a.port - b.port;
}

function compareAddress(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function abortableDelay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
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
