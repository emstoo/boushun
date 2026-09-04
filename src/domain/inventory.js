import { containsIPv4 } from "./ipv4.js";
import { resolveInterfacePolicy } from "./interface-policy.js";

const EMPTY_OVERRIDES = Object.freeze({ devices: {}, merges: [], splits: [], audit: [] });

/**
 * Converts collector output (including old v1 snapshots) into Boushun's v2 model.
 * Raw observations remain untouched; this projection can therefore be rebuilt when
 * users change an override or when a newer normalizer is installed.
 */
export function buildInventory(snapshot, overrides = EMPTY_OVERRIDES, settings = {}) {
  if (!snapshot) return emptyInventory();

  const evidence = snapshot.evidence ?? [];
  const devices = new Map();
  const interfaces = new Map();
  const assignments = new Map();
  const services = new Map();
  const networks = new Map();

  for (const raw of snapshot.devices ?? []) {
    const policy = resolveInterfacePolicy(raw.interface, raw.state, settings);
    if (raw.id !== "device:self" && !policy.identity) continue;
    const id = raw.id;
    const device = {
      id,
      name: raw.name ?? null,
      role: raw.role ?? "host",
      status: normalizeStatus(raw.state),
      manufacturer: raw.manufacturer ?? null,
      model: raw.model ?? null,
      os: raw.os ?? null,
      identityConfidence: raw.identityConfidence ?? "weak",
      sourceKinds: unique([raw.source, ...(raw.sourceKinds ?? [])].filter(Boolean)),
      tags: unique(raw.tags ?? []),
      interfaceIds: [],
      ipAssignmentIds: [],
      evidenceIds: unique(raw.evidenceIds ?? []),
      interfacePolicy: policy,
    };
    devices.set(id, device);

    const interfaceId = interfaceIdentifier(id, raw.mac, raw.interface);
    const networkInterface = {
      id: interfaceId,
      deviceId: id,
      name: raw.interface ?? null,
      mac: raw.mac ?? null,
      kind: raw.role === "scanner" ? "physical" : "observed",
      state: raw.state ?? "UNKNOWN",
      evidenceIds: unique(raw.evidenceIds ?? []),
      ...policyFields(policy),
    };
    interfaces.set(interfaceId, networkInterface);
    device.interfaceIds.push(interfaceId);

    for (const address of raw.addresses ?? []) {
      addAssignment(assignments, device, {
        address,
        family: address.includes(":") ? "ipv6" : "ipv4",
        kind: raw.role === "scanner" ? "primary" : "unknown",
        deviceId: id,
        interfaceId,
        advertisedByDeviceIds: [],
        serviceIds: [],
        confidence: raw.identityConfidence ?? "weak",
        evidenceIds: unique(raw.evidenceIds ?? []),
        mapVisible: policy.map,
      });
    }
  }

  // Replace the synthetic scanner interface with the actual local interfaces.
  const scanner = devices.get("device:self");
  if (scanner) {
    for (const oldId of scanner.interfaceIds) interfaces.delete(oldId);
    for (const oldId of scanner.ipAssignmentIds) assignments.delete(oldId);
    scanner.interfaceIds = [];
    scanner.ipAssignmentIds = [];
    for (const item of snapshot.interfaces ?? []) {
      if (item.name === "lo") continue;
      const policy = resolveInterfacePolicy(item.name, item.state, settings);
      const interfaceId = `interface:self:${safeId(item.name)}`;
      interfaces.set(interfaceId, {
        id: interfaceId,
        deviceId: scanner.id,
        name: item.name,
        mac: item.mac ?? null,
        kind: "physical",
        state: item.state ?? "UNKNOWN",
        mtu: item.mtu ?? null,
        evidenceIds: unique((item.addresses ?? []).map((address) => address.evidenceId).filter(Boolean)),
        ...policyFields(policy),
      });
      scanner.interfaceIds.push(interfaceId);
      for (const address of item.addresses ?? []) {
        addAssignment(assignments, scanner, {
          address: address.address,
          family: address.address.includes(":") ? "ipv6" : "ipv4",
          kind: "primary",
          deviceId: scanner.id,
          interfaceId,
          advertisedByDeviceIds: [],
          serviceIds: [],
          confidence: "verified",
          evidenceIds: unique([address.evidenceId].filter(Boolean)),
          mapVisible: policy.map,
        });
      }
    }
  }

  for (const item of snapshot.interfaces ?? []) {
    if (item.name === "lo") continue;
    const policy = resolveInterfacePolicy(item.name, item.state, settings);
    if (!policy.map) continue;
    for (const address of item.addresses ?? []) {
      if (!networks.has(address.cidr)) {
        networks.set(address.cidr, {
          id: `network:${address.cidr}`,
          cidr: address.cidr,
          name: address.cidr,
          family: address.address.includes(":") ? "ipv6" : "ipv4",
          evidenceIds: unique([address.evidenceId].filter(Boolean)),
        });
      }
    }
  }

  applyKubernetes(snapshot.kubernetes, { devices, assignments, services, evidence });
  applyTcpServices(snapshot.tcpServices, { devices, interfaces, assignments, services });
  applyUdpServices(snapshot.udpServices, { devices, interfaces, assignments, services });
  applyExternalServices(snapshot.controller?.services, { assignments, services });
  applyDiscovery(snapshot.discovery, { devices, assignments });
  applySplits(overrides.splits, { devices, interfaces, assignments });
  applyMerges(overrides.merges, { devices, interfaces, assignments });
  applyDeviceOverrides(overrides.devices, devices);
  annotateDeviceIdentities(snapshot, { devices, interfaces, assignments });

  for (const assignment of assignments.values()) {
    assignment.networkId = findNetwork(assignment.address, networks);
  }

  return {
    version: 2,
    devices: [...devices.values()],
    interfaces: [...interfaces.values()],
    ipAssignments: [...assignments.values()],
    services: [...services.values()],
    networks: [...networks.values()],
    links: uniqueLinks(snapshot.explicitLinks ?? []),
  };
}

function annotateDeviceIdentities(snapshot, { devices, interfaces, assignments }) {
  const discoveryRecords = [
    ...(snapshot.discovery?.dhcp ?? []),
    ...(snapshot.discovery?.mdns ?? []),
    ...(snapshot.discovery?.ssdp ?? []),
  ];
  for (const device of devices.values()) {
    const addresses = assignmentsForDevice(device.id, assignments).map((item) => item.address).sort(compareAddress);
    const addressSet = new Set(addresses);
    const nameCandidates = unique(discoveryRecords
      .filter((record) => addressSet.has(record.address))
      .flatMap((record) => [record.hostname, record.name])
      .filter(Boolean));
    const mac = [...interfaces.values()].find((item) => item.deviceId === device.id && item.mac)?.mac ?? null;
    const issues = [];
    const ipv4Addresses = addresses.filter((address) => !address.includes(":"));
    if (
      ipv4Addresses.length >= 3
      && mac
      && device.role !== "scanner"
      && device.sourceKinds.includes("neighbor-cache")
      && !device.manuallyEdited
    ) {
      device.identityConfidence = "conflicted";
      issues.push({
        code: "shared-mac-multiple-addresses",
        severity: "review",
        message: `${ipv4Addresses.length} IPv4 addresses were grouped by one neighbor-cache MAC. Proxy ARP or a routed hop may make these separate devices.`,
        addresses: ipv4Addresses,
        recommendedAction: {
          type: "split-addresses",
          keepAddress: ipv4Addresses[0],
          addresses: ipv4Addresses.slice(1),
        },
      });
    }
    if (!mac && device.id.startsWith("device:ip:") && !device.manuallyEdited) {
      issues.push({
        code: "address-only-identity",
        severity: "info",
        message: "This identity is based only on an IP response. A later MAC, DHCP, mDNS, or controller observation may reconcile it.",
        addresses,
      });
    }
    device.nameCandidates = nameCandidates;
    device.suggestedName = device.name || nameCandidates[0] || suggestedDeviceName(device, addresses, ipv4Addresses.length);
    device.identityIssues = issues;
    device.needsIdentityReview = issues.some((issue) => issue.severity === "review");
  }
}

function assignmentsForDevice(deviceId, assignments) {
  return [...assignments.values()].filter((assignment) => assignment.deviceId === deviceId);
}

function suggestedDeviceName(device, addresses, ipv4Count) {
  const address = addresses[0] ?? null;
  const maker = String(device.manufacturer ?? "").split(",")[0].trim();
  if (ipv4Count >= 3 && maker) return `${maker} group · ${ipv4Count} addresses`;
  if (maker && address) return `${maker} · ${address}`;
  if (address) return `${roleLabel(device.role)} · ${address}`;
  return `${roleLabel(device.role)} · ${String(device.id).slice(-8)}`;
}

function roleLabel(role) {
  return String(role || "device").split("-").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function compareAddress(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function applyTcpServices(tcpServices, context) {
  applyObservedServices(tcpServices?.endpoints, context, {
    protocol: "tcp",
    sourceKind: "tcp-connect",
    interfaceKind: "tcp-observed",
  });
}

function applyUdpServices(udpServices, context) {
  applyObservedServices(udpServices?.endpoints, context, {
    protocol: "udp",
    sourceKind: "udp-probe",
    interfaceKind: "udp-observed",
  });
}

function applyObservedServices(endpoints, context, options) {
  for (const endpoint of endpoints ?? []) {
    const evidenceIds = unique(endpoint.evidenceIds ?? []);
    let assignment = context.assignments.get(`ip:${endpoint.address}`);
    if (!assignment) {
      const deviceId = `device:ip:${endpoint.address}`;
      let device = context.devices.get(deviceId);
      if (!device) {
        const interfaceId = `interface:${safeId(deviceId)}:${options.interfaceKind}`;
        device = {
          id: deviceId,
          name: null,
          role: "host",
          status: "online",
          manufacturer: null,
          model: null,
          os: null,
          identityConfidence: "inferred",
          sourceKinds: [options.sourceKind],
          tags: [],
          interfaceIds: [interfaceId],
          ipAssignmentIds: [],
          evidenceIds,
          interfacePolicy: { map: true, identity: true, scan: true },
        };
        context.devices.set(deviceId, device);
        context.interfaces.set(interfaceId, {
          id: interfaceId,
          deviceId,
          name: null,
          mac: null,
          kind: options.interfaceKind,
          state: "OPEN",
          evidenceIds,
          mapVisible: true,
          identityEligible: true,
          scanEligible: true,
        });
      }
      assignment = {
        id: `ip:${endpoint.address}`,
        address: endpoint.address,
        family: "ipv4",
        kind: "observed",
        deviceId,
        interfaceId: device.interfaceIds[0],
        advertisedByDeviceIds: [],
        serviceIds: [],
        confidence: "verified",
        evidenceIds,
        mapVisible: true,
      };
      context.assignments.set(assignment.id, assignment);
      device.ipAssignmentIds.push(assignment.id);
    }

    const serviceId = `service:${options.protocol}:${safeId(endpoint.address)}:${endpoint.port}`;
    context.services.set(serviceId, {
      id: serviceId,
      name: `${endpoint.service ?? options.protocol} · ${endpoint.port}/${options.protocol}`,
      namespace: endpoint.address,
      kind: `${options.protocol}-service`,
      clusterAddresses: [],
      addresses: [endpoint.address],
      ports: [{ name: endpoint.service ?? null, protocol: options.protocol.toUpperCase(), port: endpoint.port }],
      evidenceIds,
    });
    assignment.serviceIds = unique([...(assignment.serviceIds ?? []), serviceId]);
    assignment.evidenceIds = unique([...(assignment.evidenceIds ?? []), ...evidenceIds]);
    const device = assignment.deviceId ? context.devices.get(assignment.deviceId) : null;
    if (device) {
      device.status = "online";
      device.sourceKinds = unique([...device.sourceKinds, options.sourceKind]);
      device.evidenceIds = unique([...device.evidenceIds, ...evidenceIds]);
    }
  }
}

function applyExternalServices(inputs, context) {
  for (const source of inputs ?? []) {
    const id = source.id ?? `service:controller:${safeId(source.namespace ?? "default")}:${safeId(source.name ?? "service")}`;
    const service = {
      id,
      name: source.name ?? "service",
      namespace: source.namespace ?? "controller",
      kind: source.kind ?? "controller-service",
      clusterAddresses: unique(source.clusterAddresses ?? []),
      addresses: unique(source.addresses ?? []),
      ports: source.ports ?? [],
      evidenceIds: unique(source.evidenceIds ?? []),
    };
    context.services.set(id, service);
    for (const address of service.addresses) {
      const existing = context.assignments.get(`ip:${address}`);
      if (existing) {
        existing.kind = "service";
        existing.serviceIds = unique([...(existing.serviceIds ?? []), id]);
      }
    }
  }
}

export function withInventory(snapshot, overrides, settings) {
  return snapshot ? { ...snapshot, schemaVersion: 2, inventory: buildInventory(snapshot, overrides, settings) } : null;
}

function applyKubernetes(kubernetes, context) {
  if (!kubernetes) return;
  for (const node of kubernetes.nodes ?? []) {
    const assignment = (node.addresses ?? [])
      .map((address) => context.assignments.get(`ip:${address}`))
      .find(Boolean);
    const device = assignment ? context.devices.get(assignment.deviceId) : null;
    if (!device) continue;
    device.name = node.name || device.name;
    device.role = "kubernetes-node";
    device.os = node.osImage ?? device.os;
    device.model = node.architecture ?? device.model;
    device.sourceKinds = unique([...device.sourceKinds, "kubernetes-api"]);
    device.tags = unique([...device.tags, ...(node.roles ?? []).map((role) => `k8s:${role}`)]);
    device.evidenceIds = unique([...device.evidenceIds, ...(node.evidenceIds ?? [])]);
    device.identityConfidence = "verified";
  }

  for (const source of kubernetes.services ?? []) {
    const id = `service:kubernetes:${safeId(source.namespace)}:${safeId(source.name)}`;
    const service = {
      id,
      name: source.name,
      namespace: source.namespace,
      kind: source.kind ?? "kubernetes-service",
      clusterAddresses: unique(source.clusterAddresses ?? []),
      addresses: unique(source.addresses ?? []),
      ports: source.ports ?? [],
      evidenceIds: unique(source.evidenceIds ?? []),
    };
    context.services.set(id, service);
    for (const address of service.addresses) {
      const existing = context.assignments.get(`ip:${address}`);
      if (existing) {
        const formerOwner = existing.deviceId;
        existing.kind = "vip";
        existing.deviceId = null;
        existing.interfaceId = null;
        existing.advertisedByDeviceIds = unique([
          ...(existing.advertisedByDeviceIds ?? []),
          ...(formerOwner ? [formerOwner] : []),
        ]);
        existing.serviceIds = unique([...existing.serviceIds, id]);
        existing.confidence = "verified";
      } else {
        context.assignments.set(`ip:${address}`, {
          id: `ip:${address}`,
          address,
          family: address.includes(":") ? "ipv6" : "ipv4",
          kind: "vip",
          deviceId: null,
          interfaceId: null,
          advertisedByDeviceIds: [],
          serviceIds: [id],
          confidence: "verified",
          evidenceIds: unique(source.evidenceIds ?? []),
        });
      }
    }
  }
}

function applyDiscovery(discovery, { devices, assignments }) {
  for (const record of [
    ...(discovery?.dhcp ?? []),
    ...(discovery?.mdns ?? []),
    ...(discovery?.ssdp ?? []),
  ]) {
    const assignment = assignments.get(`ip:${record.address}`);
    const device = assignment ? devices.get(assignment.deviceId) : null;
    if (!device) continue;
    device.name ||= record.hostname ?? record.name ?? null;
    device.manufacturer ||= record.manufacturer ?? null;
    device.model ||= record.model ?? null;
    device.sourceKinds = unique([...device.sourceKinds, record.source ?? "discovery"]);
    device.evidenceIds = unique([...device.evidenceIds, ...(record.evidenceIds ?? [])]);
  }
}

function applyDeviceOverrides(rawOverrides, devices) {
  if (!rawOverrides || typeof rawOverrides !== "object") return;
  for (const [id, override] of Object.entries(rawOverrides)) {
    const device = devices.get(id);
    if (!device || !override || typeof override !== "object") continue;
    if (typeof override.name === "string") device.name = override.name || null;
    if (typeof override.role === "string" && override.role) device.role = override.role;
    if (Array.isArray(override.tags)) device.tags = unique(override.tags.filter((tag) => typeof tag === "string"));
    device.manuallyEdited = true;
  }
}

function applyMerges(merges, { devices, interfaces, assignments }) {
  for (const merge of Array.isArray(merges) ? merges : []) {
    const sourceIds = unique(merge?.sourceIds ?? []).filter((id) => devices.has(id));
    if (sourceIds.length < 2) continue;
    const targetId = merge.targetId || sourceIds[0];
    const members = sourceIds.map((id) => devices.get(id));
    const target = devices.get(targetId) ?? { ...members[0], id: targetId };
    target.name = merge.name || members.find((item) => item.name)?.name || null;
    target.role = merge.role || members.find((item) => item.role !== "host")?.role || "host";
    target.interfaceIds = unique(members.flatMap((item) => item.interfaceIds));
    target.ipAssignmentIds = unique(members.flatMap((item) => item.ipAssignmentIds));
    target.evidenceIds = unique(members.flatMap((item) => item.evidenceIds));
    target.sourceKinds = unique(members.flatMap((item) => item.sourceKinds));
    for (const sourceId of sourceIds) devices.delete(sourceId);
    devices.set(targetId, target);
    for (const item of interfaces.values()) if (sourceIds.includes(item.deviceId)) item.deviceId = targetId;
    for (const item of assignments.values()) {
      if (sourceIds.includes(item.deviceId)) item.deviceId = targetId;
      item.advertisedByDeviceIds = (item.advertisedByDeviceIds ?? []).map((id) => sourceIds.includes(id) ? targetId : id);
    }
  }
}

function applySplits(splits, { devices, interfaces, assignments }) {
  for (const split of Array.isArray(splits) ? splits : []) {
    const source = devices.get(split?.sourceId);
    const addresses = unique(split?.addresses ?? []);
    if (!source || !addresses.length || !split.targetId) continue;
    const moved = addresses.map((address) => assignments.get(`ip:${address}`))
      .filter((assignment) => assignment?.deviceId === source.id);
    if (!moved.length) continue;
    const target = {
      ...source,
      id: split.targetId,
      name: split.name ?? null,
      role: split.role ?? "host",
      interfaceIds: [],
      ipAssignmentIds: moved.map((item) => item.id),
      evidenceIds: unique(moved.flatMap((item) => item.evidenceIds)),
      identityConfidence: "inferred",
      manuallyEdited: true,
    };
    for (const item of moved) {
      item.deviceId = target.id;
      const original = interfaces.get(item.interfaceId);
      const interfaceId = interfaceIdentifier(target.id, original?.mac, original?.name);
      if (!interfaces.has(interfaceId)) interfaces.set(interfaceId, { ...original, id: interfaceId, deviceId: target.id, kind: "manual-split" });
      item.interfaceId = interfaceId;
      target.interfaceIds.push(interfaceId);
      source.ipAssignmentIds = source.ipAssignmentIds.filter((id) => id !== item.id);
    }
    target.interfaceIds = unique(target.interfaceIds);
    devices.set(target.id, target);
  }
}

function addAssignment(assignments, device, input) {
  const id = `ip:${input.address}`;
  const existing = assignments.get(id);
  if (existing) {
    existing.evidenceIds = unique([...existing.evidenceIds, ...input.evidenceIds]);
    if (existing.deviceId === input.deviceId) device.ipAssignmentIds = unique([...device.ipAssignmentIds, id]);
    return existing;
  }
  const result = { id, ...input };
  assignments.set(id, result);
  device.ipAssignmentIds.push(id);
  return result;
}

function interfaceIdentifier(deviceId, mac, name) {
  return `interface:${safeId(deviceId)}:${safeId(mac || name || "unknown")}`;
}

function findNetwork(address, networks) {
  if (address.includes(":")) return null;
  for (const network of networks.values()) if (containsIPv4(network.cidr, address)) return network.id;
  return null;
}

function normalizeStatus(state) {
  const value = String(state ?? "unknown").toUpperCase();
  if (["UP", "REACHABLE", "PERMANENT", "NOARP"].some((token) => value.includes(token))) return "online";
  if (["STALE", "DELAY", "PROBE"].some((token) => value.includes(token))) return "recent";
  if (["DOWN", "FAILED"].some((token) => value.includes(token))) return "offline";
  return "unknown";
}

function safeId(value) {
  return encodeURIComponent(String(value ?? "unknown")).replace(/%/g, "_");
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueLinks(links) {
  return [...new Map(links.map((link) => [link.id, link])).values()];
}

function policyFields(policy) {
  return { mapVisible: policy.map, identityEligible: policy.identity, scanEligible: policy.scan };
}

function emptyInventory() {
  return { version: 2, devices: [], interfaces: [], ipAssignments: [], services: [], networks: [], links: [] };
}
