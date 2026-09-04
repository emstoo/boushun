import { createHash, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { assertSafeScanCIDR, hostAddresses, parseCIDR } from "../domain/ipv4.js";
import { resolveInterfacePolicy } from "../domain/interface-policy.js";
import { runCommand } from "../lib/command.js";

const DEFAULT_DHCP_LEASE_PATHS = [
  "/var/lib/misc/dnsmasq.leases",
  "/var/lib/dnsmasq/dnsmasq.leases",
  "/var/lib/NetworkManager/dnsmasq.leases",
];

export async function collectLinux(options = {}) {
  const {
    profile = "passive",
    cidr: requestedCIDR,
    allowedCIDRs = [],
    runner = defaultRunner,
    textReader = readFile,
    reverseLookup = defaultReverseLookup,
    now = () => new Date(),
    pingConcurrency = 24,
    signal,
    onProgress = () => {},
    dhcpLeasePaths = splitPaths(process.env.BOUSHUN_DHCP_LEASE_PATHS),
    settings = {},
  } = options;

  if (!new Set(["passive", "standard", "deep"]).has(profile)) {
    throw new Error("profile must be passive, standard, or deep");
  }

  const observedAt = now().toISOString();
  const evidence = createEvidenceFactory(observedAt);
  const warnings = [];

  let addresses = [];
  let routes = [];
  let neighbors = [];

  onProgress({ phase: "local-facts", completed: 0, total: 3, message: "Reading local network facts" });
  throwIfAborted(signal);
  const initialResults = await Promise.allSettled([
    runJson(runner, "ip", ["-json", "address", "show"], signal),
    runJson(runner, "ip", ["-json", "route", "show", "table", "main"], signal),
    runJson(runner, "ip", ["-json", "neigh", "show"], signal),
  ]);
  throwIfAborted(signal);
  onProgress({ phase: "local-facts", completed: 3, total: 3, message: "Local network facts collected" });

  addresses = settledValue(initialResults[0], warnings, "Unable to read interface information", []);
  routes = settledValue(initialResults[1], warnings, "Unable to read routing information", []);
  neighbors = settledValue(initialResults[2], warnings, "Unable to read the neighbor cache", []);

  const interfaces = parseInterfaces(addresses, evidence);
  const parsedRoutes = parseRoutes(routes, evidence);
  let scan = null;

  if (profile === "standard" || profile === "deep") {
    const selectedCIDR = requestedCIDR || chooseDefaultScanCIDR(interfaces, settings);
    if (!selectedCIDR) {
      throw new Error("No eligible private IPv4 interface was found");
    }

    const safeCIDR = assertSafeScanCIDR(selectedCIDR, allowedCIDRs);
    const localAddresses = interfaces.flatMap((item) => item.addresses.map((address) => address.address));
    const targets = hostAddresses(safeCIDR, localAddresses);
    const probes = await pingSweep(targets, {
      runner,
      concurrency: pingConcurrency,
      signal,
      onProgress,
      evidence,
      observedAt,
    });
    const responsive = probes.filter((probe) => probe.result === "response").map((probe) => probe.address);
    scan = {
      cidr: safeCIDR.canonical,
      targetCount: targets.length,
      responsiveCount: responsive.length,
      method: "icmp-echo",
      probes,
    };

    try {
      neighbors = await runJson(runner, "ip", ["-json", "neigh", "show"], signal);
    } catch (error) {
      warnings.push(`Unable to refresh the neighbor cache after discovery: ${safeMessage(error)}`);
    }
  }

  const resolver = await readResolverConfig(textReader, warnings);
  const leaseResult = await readDhcpLeases(textReader, dhcpLeasePaths.length ? dhcpLeasePaths : DEFAULT_DHCP_LEASE_PATHS);
  const leases = leaseResult.leases;
  const dhcpDiscovery = leases.map((lease) => {
    const record = evidence.add(
      "dhcp-lease",
      lease.source,
      `${lease.address}${lease.hostname ? ` is leased to ${lease.hostname}` : ""} appears in a DHCP lease`,
      lease,
    );
    return { ...lease, source: "dhcp", evidenceIds: [record.id] };
  });
  const parsedNeighbors = parseNeighbors(neighbors, evidence);
  const names = profile === "standard" || profile === "deep"
    ? await resolveNeighborNames(parsedNeighbors, leases, reverseLookup)
    : leaseNames(leases);

  const snapshot = assembleSnapshot({
    id: randomUUID(),
    observedAt,
    profile,
    interfaces,
    routes: parsedRoutes,
    neighbors: parsedNeighbors,
    resolver,
    leases,
    names,
    scan,
    warnings,
    evidence: evidence.all(),
    discovery: { dhcp: dhcpDiscovery, mdns: [], ssdp: [] },
    settings,
    sources: [
      sourceFromSettled("local-network", "Local network facts", initialResults, interfaces.length + parsedRoutes.length + parsedNeighbors.length),
      {
        id: "dns-config",
        label: "DNS configuration",
        configured: resolver.length > 0,
        status: resolver.length > 0 ? "connected" : "unavailable",
        recordCount: resolver.length,
        message: resolver.length > 0 ? `${resolver.length} resolver${resolver.length === 1 ? "" : "s"} configured` : "No resolver was readable from /etc/resolv.conf",
      },
      {
        id: "dhcp-leases",
        label: "DHCP leases",
        configured: leaseResult.readablePaths.length > 0,
        status: leaseResult.readablePaths.length > 0 ? "connected" : "not-configured",
        recordCount: leases.length,
        message: leaseResult.readablePaths.length > 0
          ? `${leaseResult.readablePaths.length} lease source${leaseResult.readablePaths.length === 1 ? "" : "s"} readable`
          : "No configured DHCP lease file was readable",
      },
    ],
  });

  return snapshot;
}

export function parseInterfaces(rawInterfaces, evidenceFactory = createEvidenceFactory(new Date().toISOString())) {
  if (!Array.isArray(rawInterfaces)) return [];
  return rawInterfaces
    .map((item) => {
      const addresses = (item.addr_info || [])
        .filter((address) => address.family === "inet" && address.local)
        .map((address) => {
          const cidr = parseCIDR(`${address.local}/${address.prefixlen}`);
          const evidence = evidenceFactory.add(
            "interface-address",
            "iproute2",
            `${address.local}/${address.prefixlen} is configured on ${item.ifname}`,
            { ifname: item.ifname, ...address },
          );
          return {
            address: address.local,
            prefix: address.prefixlen,
            cidr: cidr?.canonical ?? `${address.local}/${address.prefixlen}`,
            scope: address.scope ?? "unknown",
            evidenceId: evidence.id,
          };
        });

      if (!addresses.length && item.ifname !== "lo") return null;
      return {
        index: item.ifindex,
        name: item.ifname,
        mac: normalizeMac(item.address),
        state: item.operstate ?? "UNKNOWN",
        mtu: item.mtu,
        addresses,
      };
    })
    .filter(Boolean);
}

export function parseRoutes(rawRoutes, evidenceFactory = createEvidenceFactory(new Date().toISOString())) {
  if (!Array.isArray(rawRoutes)) return [];
  return rawRoutes
    .filter((route) => route.dst || route.gateway)
    .map((route) => {
      const evidence = evidenceFactory.add(
        route.dst === "default" ? "default-route" : "route",
        "iproute2",
        route.dst === "default"
          ? `The default gateway is ${route.gateway ?? route.dev}`
          : `The route to ${route.dst} uses ${route.dev ?? route.gateway}`,
        route,
      );
      return {
        destination: route.dst ?? "default",
        gateway: route.gateway ?? null,
        interface: route.dev ?? null,
        source: route.prefsrc ?? null,
        metric: route.metric ?? null,
        protocol: route.protocol ?? null,
        evidenceId: evidence.id,
      };
    });
}

export function parseNeighbors(rawNeighbors, evidenceFactory = createEvidenceFactory(new Date().toISOString())) {
  if (!Array.isArray(rawNeighbors)) return [];
  return rawNeighbors
    .filter((neighbor) => neighbor.dst && !isFailedState(neighbor.state))
    .map((neighbor) => {
      const state = Array.isArray(neighbor.state)
        ? neighbor.state.join(",")
        : neighbor.state ?? "UNKNOWN";
      const mac = normalizeMac(neighbor.lladdr);
      const evidence = evidenceFactory.add(
        "neighbor-cache",
        "iproute2",
        mac
          ? `${neighbor.dst} was observed as ${mac} on ${neighbor.dev}`
          : `${neighbor.dst} was observed on ${neighbor.dev}`,
        neighbor,
      );
      return {
        address: neighbor.dst,
        mac,
        interface: neighbor.dev ?? null,
        state,
        evidenceId: evidence.id,
      };
    });
}

export function chooseDefaultScanCIDR(interfaces, settings = {}) {
  const candidates = interfaces
    .filter((item) => resolveInterfacePolicy(item.name, item.state, settings).scan)
    .flatMap((item) => item.addresses)
    .map((item) => parseCIDR(`${item.address}/${Math.max(24, item.prefix)}`))
    .filter((item) => item && isPrivateCandidate(item));
  return candidates[0]?.canonical ?? null;
}

async function pingSweep(targets, { runner, concurrency, signal, onProgress, evidence, observedAt }) {
  const probes = [];
  let cursor = 0;
  let completed = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      throwIfAborted(signal);
      const started = performance.now();
      let result = "timeout";
      try {
        await runner("ping", ["-n", "-c", "1", "-W", "1", target], {
          timeout: 1_500,
          maxBuffer: 64 * 1024,
          signal,
        });
        result = "response";
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw abortError();
        // A timeout is an expected negative result, not an application error.
      }
      const latencyMs = Math.max(0, Math.round((performance.now() - started) * 10) / 10);
      const record = evidence.add(
        `probe-${result}`,
        "icmp-echo",
        result === "response" ? `${target} responded to ICMP echo` : `${target} did not respond to ICMP echo`,
        { address: target, result, latencyMs, observedAt },
      );
      probes.push({ address: target, result, latencyMs, evidenceId: record.id });
      completed += 1;
      onProgress({ phase: "icmp", completed, total: targets.length, message: `${completed}/${targets.length} addresses` });
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, targets.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return probes.sort((a, b) => targets.indexOf(a.address) - targets.indexOf(b.address));
}

async function readResolverConfig(textReader, warnings) {
  try {
    const text = await textReader("/etc/resolv.conf", "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*nameserver\s+(\S+)/)?.[1])
      .filter(Boolean);
  } catch (error) {
    warnings.push(`Unable to read DNS configuration: ${safeMessage(error)}`);
    return [];
  }
}

async function readDhcpLeases(textReader, leasePaths) {
  const leases = [];
  const readablePaths = [];
  for (const leasePath of leasePaths) {
    try {
      const text = await textReader(leasePath, "utf8");
      readablePaths.push(leasePath);
      leases.push(...parseLeaseDocument(text, leasePath));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") continue;
    }
  }
  return { leases, readablePaths, configuredPaths: leasePaths };
}

export function parseLeaseDocument(text, source = "lease-file") {
  const trimmed = String(text).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const records = Array.isArray(parsed) ? parsed : parsed.leases ?? [];
      return records.map((item) => ({
        expiresAt: Number(item.expire ?? item.expiresAt) || null,
        mac: normalizeMac(item["hw-address"] ?? item.mac ?? item.hwAddress),
        address: item["ip-address"] ?? item.address ?? item.ip,
        hostname: item.hostname ?? null,
        source,
      })).filter((item) => item.address);
    } catch {
      return [];
    }
  }
  const dnsmasq = trimmed.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 4 && normalizeMac(fields[1]))
    .map(([expiresAt, mac, address, hostname]) => ({
      expiresAt: Number(expiresAt) || null,
      mac: normalizeMac(mac),
      address,
      hostname: hostname === "*" ? null : hostname,
      source,
    }));
  if (dnsmasq.length) return dnsmasq;
  const isc = [];
  for (const block of trimmed.matchAll(/lease\s+(\S+)\s*\{([\s\S]*?)\}/g)) {
    const address = block[1];
    const body = block[2];
    const mac = normalizeMac(body.match(/hardware\s+ethernet\s+([^;]+);/)?.[1]);
    const hostname = body.match(/client-hostname\s+"([^"]+)";/)?.[1] ?? null;
    isc.push({ expiresAt: null, mac, address, hostname, source });
  }
  return isc;
}

async function resolveNeighborNames(neighbors, leases, reverseLookup) {
  const names = leaseNames(leases);
  const unresolved = [...new Set(neighbors.map((item) => item.address))]
    .filter((address) => !names[address]);
  let cursor = 0;

  const worker = async () => {
    while (cursor < unresolved.length) {
      const index = cursor;
      cursor += 1;
      const address = unresolved[index];
      try {
        const result = await reverseLookup(address);
        if (result?.[0]) names[address] = result[0].replace(/\.$/, "");
      } catch {
        // Missing PTR records are normal on home networks.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, unresolved.length || 1) }, () => worker()));
  return names;
}

function leaseNames(leases) {
  return Object.fromEntries(
    leases.filter((lease) => lease.hostname).map((lease) => [lease.address, lease.hostname]),
  );
}

function assembleSnapshot(input) {
  const localAddresses = new Set(
    input.interfaces.flatMap((item) => item.addresses.map((address) => address.address)),
  );
  const gatewayAddresses = new Set(
    input.routes.filter((route) => route.destination === "default" && route.gateway).map((route) => route.gateway),
  );
  const leaseByAddress = new Map(input.leases.map((lease) => [lease.address, lease]));

  const devices = input.neighbors.map((neighbor) => {
    const lease = leaseByAddress.get(neighbor.address);
    return {
      id: deviceId(neighbor.mac, neighbor.address),
      addresses: [neighbor.address],
      mac: neighbor.mac,
      name: input.names[neighbor.address] ?? null,
      role: gatewayAddresses.has(neighbor.address) ? "gateway" : "host",
      state: neighbor.state,
      interface: neighbor.interface,
      identityConfidence: neighbor.mac ? "strong" : "weak",
      evidenceIds: [neighbor.evidenceId],
      source: lease ? "neighbor-cache+dhcp" : "neighbor-cache",
    };
  });

  for (const networkInterface of input.interfaces) {
    if (networkInterface.name === "lo") continue;
    const addresses = networkInterface.addresses.map((item) => item.address);
    if (!addresses.length) continue;
    devices.push({
      id: "device:self",
      addresses,
      mac: networkInterface.mac,
      name: os.hostname(),
      role: "scanner",
      state: networkInterface.state,
      interface: networkInterface.name,
      identityConfidence: "verified",
      evidenceIds: networkInterface.addresses.map((item) => item.evidenceId),
      source: "local-interface",
    });
    break;
  }

  return {
    id: input.id,
    observedAt: input.observedAt,
    profile: input.profile,
    platform: process.platform,
    hostname: os.hostname(),
    interfaces: input.interfaces,
    routes: input.routes,
    resolver: input.resolver,
    devices: deduplicateDevices(devices),
    evidence: input.evidence,
    discovery: input.discovery,
    scan: input.scan,
    scanCandidates: buildScanCandidates(input.interfaces, input.settings),
    sources: [...input.sources, input.scan ? {
      id: "icmp",
      label: "ICMP discovery",
      configured: true,
      status: "connected",
      recordCount: input.scan.probes.length,
      message: `${input.scan.responsiveCount}/${input.scan.targetCount} addresses responded`,
    } : {
      id: "icmp",
      label: "ICMP discovery",
      configured: true,
      status: "not-run",
      recordCount: 0,
      message: "Run a standard or deep scan to probe the selected scope",
    }],
    warnings: input.warnings,
    summary: {
      deviceCount: new Set(devices.map((device) => device.id)).size,
      neighborCount: input.neighbors.length,
      networkCount: new Set(
        input.interfaces.flatMap((item) => item.addresses.map((address) => address.cidr)),
      ).size,
      localAddressCount: localAddresses.size,
    },
  };
}

function buildScanCandidates(interfaces, settings = {}) {
  return [...new Set(
    interfaces
      .filter((item) => resolveInterfacePolicy(item.name, item.state, settings).scan)
      .flatMap((item) => item.addresses)
      .map((item) => parseCIDR(`${item.address}/${Math.max(24, item.prefix)}`))
      .filter((item) => item && isPrivateCandidate(item))
      .map((item) => item.canonical),
  )];
}

function sourceFromSettled(id, label, results, recordCount) {
  const succeeded = results.filter((item) => item.status === "fulfilled").length;
  const status = succeeded === results.length ? "connected" : succeeded > 0 ? "degraded" : "unavailable";
  return {
    id,
    label,
    configured: true,
    status,
    recordCount,
    message: `${succeeded}/${results.length} local data requests succeeded`,
  };
}

function deduplicateDevices(devices) {
  const byId = new Map();
  for (const device of devices) {
    const existing = byId.get(device.id);
    if (!existing) {
      byId.set(device.id, device);
      continue;
    }
    existing.addresses = [...new Set([...existing.addresses, ...device.addresses])];
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...device.evidenceIds])];
    existing.name ||= device.name;
    if (device.role === "gateway") existing.role = "gateway";
  }
  return [...byId.values()];
}

function deviceId(mac, address) {
  return mac ? `device:mac:${mac}` : `device:ip:${address}`;
}

function createEvidenceFactory(observedAt) {
  const items = [];
  return {
    add(type, source, summary, raw = null) {
      const digest = createHash("sha256")
        .update(`${observedAt}\0${type}\0${source}\0${summary}\0${JSON.stringify(raw)}`)
        .digest("hex")
        .slice(0, 16);
      const item = { id: `evidence:${digest}`, type, source, observedAt, summary, raw };
      items.push(item);
      return item;
    },
    all() {
      return items;
    },
  };
}

async function runJson(runner, command, args, signal) {
  const result = await runner(command, args, { timeout: 5_000, signal });
  const stdout = typeof result === "string" ? result : result.stdout;
  return JSON.parse(stdout);
}

async function defaultRunner(command, args, options) {
  return runCommand(command, args, options);
}

async function defaultReverseLookup(address) {
  return Promise.race([
    dns.reverse(address),
    new Promise((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), 800)),
  ]);
}

function settledValue(result, warnings, context, fallback) {
  if (result.status === "fulfilled") return result.value;
  warnings.push(`${context}: ${safeMessage(result.reason)}`);
  return fallback;
}

function normalizeMac(value) {
  if (typeof value !== "string") return null;
  const compact = value.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!/^[0-9a-f]{12}$/.test(compact)) return null;
  return compact.match(/.{2}/g).join(":");
}

function isFailedState(state) {
  const states = Array.isArray(state) ? state : [state];
  return states.includes("FAILED") || states.includes("INCOMPLETE");
}

function isPrivateCandidate(cidr) {
  return (
    cidr.network.startsWith("10.") ||
    cidr.network.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(cidr.network) ||
    cidr.network.startsWith("169.254.")
  );
}

function safeMessage(error) {
  return error?.code ? `${error.code}` : String(error?.message ?? error).slice(0, 200);
}

function splitPaths(value) {
  return typeof value === "string" ? value.split(":").map((item) => item.trim()).filter(Boolean) : [];
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error("Scan cancelled");
  error.name = "AbortError";
  return error;
}
