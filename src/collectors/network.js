import path from "node:path";
import { collectLinux } from "./linux.js";
import { collectKubernetes } from "./kubernetes.js";
import { collectDiscovery } from "./discovery.js";
import { collectSnmp, readSnmpTargets } from "./snmp.js";
import { collectControllerSnapshots } from "./controller.js";
import { loadOuiDatabase, organizationForMac } from "../enrichment/oui.js";

export async function collectNetwork(options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const kubernetesCollector = options.kubernetesCollector ?? collectKubernetes;
  const controllerCollector = options.controllerCollector ?? collectControllerSnapshots;
  const discoveryCollector = options.discoveryCollector ?? collectDiscovery;
  const snmpCollector = options.snmpCollector ?? collectSnmp;
  const snapshot = await collectLinux({ ...options, onProgress });
  throwIfAborted(options.signal);

  onProgress({ phase: "identification", completed: 0, total: 2, message: "Matching Kubernetes and OUI data" });
  const kubernetes = await kubernetesCollector({
    observedAt: snapshot.observedAt,
    signal: options.signal,
    api: options.kubernetesApi,
    kubeConfig: options.kubeConfig,
  });
  snapshot.kubernetes = {
    available: kubernetes.available,
    nodes: kubernetes.nodes,
    services: kubernetes.services,
  };
  snapshot.evidence.push(...kubernetes.evidence);
  snapshot.warnings.push(...kubernetes.warnings);
  snapshot.sources.push(kubernetes.source);

  const controllerPaths = options.controllerSnapshotPaths ?? splitPaths(process.env.BOUSHUN_CONTROLLER_SNAPSHOT_PATHS);
  const controller = await controllerCollector(controllerPaths, snapshot.observedAt);
  applyController(snapshot, controller);
  snapshot.sources.push({
    id: "controller-exports",
    label: "Controller exports",
    configured: controllerPaths.length > 0,
    status: controllerPaths.length === 0 ? "not-configured" : controller.warnings.length ? "degraded" : "connected",
    recordCount: controller.devices.length + controller.links.length + controller.services.length,
    message: controllerPaths.length === 0 ? "No controller export paths are configured" : `${controllerPaths.length} export path${controllerPaths.length === 1 ? "" : "s"} configured`,
  });

  const ouiPath = options.ouiPath ?? process.env.BOUSHUN_OUI_PATH ?? path.join(options.dataDirectory ?? "data", "oui.csv");
  const oui = await loadOuiDatabase(ouiPath);
  for (const device of snapshot.devices) device.manufacturer ||= organizationForMac(oui, device.mac);
  snapshot.sources.push({
    id: "oui-database",
    label: "OUI vendor database",
    configured: oui.size > 0,
    status: oui.size > 0 ? "connected" : "not-configured",
    recordCount: oui.size,
    message: oui.size > 0 ? `Loaded ${oui.size} vendor prefixes` : "No OUI database was loaded",
  });
  onProgress({ phase: "identification", completed: 2, total: 2, message: "Identity matching complete" });

  if (options.profile === "deep") {
    onProgress({ phase: "discovery", completed: 0, total: 2, message: "Discovering mDNS and SSDP announcements" });
    const discovery = await discoveryCollector({ observedAt: snapshot.observedAt, signal: options.signal });
    snapshot.discovery = { mdns: discovery.mdns, ssdp: discovery.ssdp, dhcp: snapshot.discovery?.dhcp ?? [] };
    snapshot.evidence.push(...discovery.evidence);
    snapshot.warnings.push(...discovery.warnings);
    snapshot.sources.push(
      discoverySource("mdns", "mDNS discovery", discovery.mdns, discovery.warnings),
      discoverySource("ssdp", "SSDP discovery", discovery.ssdp, discovery.warnings),
    );
    onProgress({ phase: "discovery", completed: 1, total: 2, message: "Collecting SNMPv3 topology" });

    const snmpPath = options.snmpConfigPath ?? process.env.BOUSHUN_SNMP_CONFIG;
    const targets = options.snmpTargets ?? await readSnmpTargets(snmpPath);
    const snmpResult = await snmpCollector({
      targets,
      observedAt: snapshot.observedAt,
      signal: options.signal,
      onProgress,
      createSession: options.createSnmpSession,
    });
    snapshot.snmp = { targetCount: targets.length, observations: snmpResult.observations };
    snapshot.evidence.push(...snmpResult.evidence);
    snapshot.warnings.push(...snmpResult.warnings);
    snapshot.sources.push({
      id: "snmpv3",
      label: "SNMPv3 topology",
      configured: targets.length > 0,
      status: targets.length === 0 ? "not-configured" : snmpResult.warnings.length ? "degraded" : "connected",
      recordCount: snmpResult.observations.length,
      message: targets.length === 0 ? "No SNMPv3 targets are configured" : `${snmpResult.observations.length}/${targets.length} targets responded`,
    });
    applySnmp(snapshot, snmpResult.observations);
    onProgress({ phase: "discovery", completed: 2, total: 2, message: "Deep discovery complete" });
  } else {
    snapshot.sources.push(
      { id: "mdns", label: "mDNS discovery", configured: true, status: "not-run", recordCount: 0, message: "Run a deep scan to collect mDNS announcements" },
      { id: "ssdp", label: "SSDP discovery", configured: true, status: "not-run", recordCount: 0, message: "Run a deep scan to collect SSDP announcements" },
      { id: "snmpv3", label: "SNMPv3 topology", configured: Boolean(options.snmpTargets?.length || options.snmpConfigPath || process.env.BOUSHUN_SNMP_CONFIG), status: "not-run", recordCount: 0, message: "Run a deep scan to collect SNMPv3 topology" },
    );
  }

  return snapshot;
}

function discoverySource(id, label, records, warnings) {
  const failed = warnings.some((warning) => warning.toLowerCase().includes(id.toLowerCase()));
  return {
    id,
    label,
    configured: true,
    status: failed ? "degraded" : "connected",
    recordCount: records.length,
    message: failed ? `${label} completed with warnings` : `${label} completed`,
  };
}

function applyController(snapshot, controller) {
  const byMac = new Map(snapshot.devices.filter((item) => item.mac).map((item) => [item.mac, item]));
  const byAddress = new Map(snapshot.devices.flatMap((item) => item.addresses.map((address) => [address, item])));
  for (const input of controller.devices) {
    const existing = byMac.get(normalizeMac(input.mac)) ?? (input.addresses ?? []).map((address) => byAddress.get(address)).find(Boolean);
    if (existing) {
      existing.name = input.name || existing.name;
      existing.role = input.role || existing.role;
      existing.manufacturer = input.manufacturer || existing.manufacturer;
      existing.model = input.model || existing.model;
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...(input.evidenceIds ?? [])])];
      existing.sourceKinds = [...new Set([...(existing.sourceKinds ?? []), "controller-export"] )];
    } else if (input.mac || input.addresses?.length) {
      snapshot.devices.push({
        id: input.id ?? (input.mac ? `device:mac:${normalizeMac(input.mac)}` : `device:ip:${input.addresses[0]}`),
        name: input.name ?? null,
        role: input.role ?? "host",
        addresses: input.addresses ?? [],
        mac: normalizeMac(input.mac),
        state: input.state ?? "UNKNOWN",
        interface: input.interface ?? null,
        identityConfidence: input.identityConfidence ?? "strong",
        evidenceIds: input.evidenceIds ?? [],
        source: "controller-export",
      });
    }
  }
  const deviceIds = new Set(snapshot.devices.map((device) => device.id));
  snapshot.explicitLinks = [
    ...(snapshot.explicitLinks ?? []),
    ...controller.links.filter((link) => deviceIds.has(link.source) && deviceIds.has(link.target)),
  ];
  snapshot.controller = { services: controller.services };
  snapshot.evidence.push(...controller.evidence);
  snapshot.warnings.push(...controller.warnings);
}

function applySnmp(snapshot, observations) {
  const devicesByAddress = new Map(snapshot.devices.flatMap((device) => device.addresses.map((address) => [address, device])));
  const devicesByMac = new Map(snapshot.devices.filter((device) => device.mac).map((device) => [device.mac, device]));
  snapshot.explicitLinks ||= [];
  for (const observation of observations) {
    const source = devicesByAddress.get(observation.target);
    if (!source) continue;
    source.name = observation.name || source.name;
    source.role = source.role === "gateway" ? "gateway" : "switch";
    source.model ||= observation.description;
    source.sourceKinds = [...new Set([...(source.sourceKinds ?? []), "snmpv3"] )];
    source.evidenceIds = [...new Set([...source.evidenceIds, ...observation.evidenceIds])];
    for (const neighbor of observation.lldp ?? []) {
      const target = devicesByMac.get(normalizeMac(neighbor.chassisId));
      if (!target || target.id === source.id) continue;
      snapshot.explicitLinks.push({
        id: `link:lldp:${safeId(source.id)}:${safeId(target.id)}:${safeId(neighbor.portId)}`,
        source: source.id,
        target: target.id,
        layer: "l2",
        relation: "lldp-neighbor",
        confidence: "strong",
        label: neighbor.portDescription || neighbor.portId || "LLDP",
        evidenceIds: observation.evidenceIds,
      });
    }
    for (const entry of observation.fdb ?? []) {
      const target = devicesByMac.get(entry.mac);
      if (!target || target.id === source.id) continue;
      snapshot.explicitLinks.push({
        id: `link:fdb:${safeId(source.id)}:${safeId(target.id)}:${entry.interfaceIndex ?? entry.bridgePort}`,
        source: source.id,
        target: target.id,
        layer: "l2",
        relation: "forwarding-table",
        confidence: "inferred",
        label: `port ${entry.interfaceIndex ?? entry.bridgePort ?? "?"}`,
        evidenceIds: observation.evidenceIds,
      });
    }
  }
}

function normalizeMac(value) {
  const compact = String(value ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return compact.length === 12 ? compact.match(/.{2}/g).join(":") : null;
}

function safeId(value) {
  return encodeURIComponent(String(value));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Scan cancelled");
  error.name = "AbortError";
  throw error;
}

function splitPaths(value) {
  return typeof value === "string" ? value.split(":").map((item) => item.trim()).filter(Boolean) : [];
}
