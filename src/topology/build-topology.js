import { withInventory } from "../domain/inventory.js";

const CONFIDENCE_ORDER = ["verified", "strong", "inferred", "weak"];

export function buildTopology(snapshot, options = {}) {
  if (!snapshot) return emptyTopology(options.view);
  const normalized = snapshot.inventory ? snapshot : withInventory(snapshot, options.overrides, options.settings);
  const inventory = normalized.inventory;
  const view = ["physical", "logical", "services"].includes(options.view) ? options.view : "logical";
  const nodes = [];
  const links = [];
  let unplacedNodes = [];
  let groups = [];
  let coverage = null;

  if (view === "physical") ({ unplacedNodes, coverage } = buildPhysical(inventory, nodes, links));
  if (view === "logical") buildLogical(normalized, inventory, nodes, links);
  if (view === "services") ({ groups } = buildServices(inventory, nodes, links));

  const nodeIds = new Set(nodes.map((node) => node.id));
  const deduplicated = deduplicateLinks(links).filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target));
  return {
    generatedAt: new Date().toISOString(),
    snapshotId: snapshot.id,
    view,
    nodes: deduplicateNodes(nodes),
    links: deduplicated,
    unplacedNodes,
    groups,
    coverage,
    confidenceCounts: Object.fromEntries(CONFIDENCE_ORDER.map((confidence) => [confidence, deduplicated.filter((link) => link.confidence === confidence).length])),
    legend: [
      { confidence: "verified", label: "Verified", description: "Confirmed by configuration or API" },
      { confidence: "strong", label: "Strong", description: "High-quality evidence such as LLDP" },
      { confidence: "inferred", label: "Inferred", description: "Derived from evidence such as an FDB" },
      { confidence: "weak", label: "Weak", description: "Only observed on the same segment" },
    ],
  };
}

export function buildTopologyViews(snapshot, overrides, settings) {
  return Object.fromEntries(["physical", "logical", "services"].map((view) => [view, buildTopology(snapshot, { view, overrides, settings })]));
}

function buildPhysical(inventory, nodes, links) {
  const visibleDevices = inventory.devices.filter((device) => deviceVisible(device, inventory));
  const visibleIds = new Set(visibleDevices.map((device) => device.id));
  for (const link of inventory.links) if (visibleIds.has(link.source) && visibleIds.has(link.target)) links.push({ ...link });
  const linked = new Set(links.flatMap((link) => [link.source, link.target]));
  const placed = visibleDevices.filter((device) => linked.has(device.id));
  const unplaced = visibleDevices.filter((device) => !linked.has(device.id));
  nodes.push(...placed.map((device) => deviceNode(device, inventory)));
  return {
    unplacedNodes: unplaced.map((device) => deviceNode(device, inventory)),
    coverage: {
      placed: placed.length,
      total: visibleDevices.length,
      percent: visibleDevices.length ? Math.round((placed.length / visibleDevices.length) * 100) : 0,
    },
  };
}

function buildLogical(snapshot, inventory, nodes, links) {
  nodes.push(...inventory.networks.map(networkNode), ...inventory.devices.filter((device) => deviceVisible(device, inventory)).map((device) => deviceNode(device, inventory)));
  links.push(...inventory.links);
  const assignments = new Map(inventory.ipAssignments.map((item) => [item.id, item]));
  for (const device of inventory.devices) {
    for (const assignmentId of device.ipAssignmentIds) {
      const assignment = assignments.get(assignmentId);
      if (!assignment?.networkId || assignment.kind === "vip" || assignment.mapVisible === false) continue;
      links.push({ id: `link:membership:${safeId(assignment.networkId)}:${safeId(device.id)}`, source: assignment.networkId, target: device.id, layer: "l3", relation: "address-membership", confidence: assignment.confidence, label: assignment.address, evidenceIds: assignment.evidenceIds });
    }
  }
  for (const assignment of inventory.ipAssignments.filter((item) => item.kind === "vip")) {
    nodes.push(ipNode(assignment));
    if (assignment.networkId) links.push({ id: `link:vip-network:${safeId(assignment.id)}`, source: assignment.networkId, target: assignment.id, layer: "l3", relation: "virtual-address", confidence: assignment.confidence, label: "VIP", evidenceIds: assignment.evidenceIds });
    for (const deviceId of assignment.advertisedByDeviceIds ?? []) links.push({ id: `link:advertiser:${safeId(assignment.id)}:${safeId(deviceId)}`, source: assignment.id, target: deviceId, layer: "l3", relation: "advertised-by", confidence: "strong", label: "advertised by", evidenceIds: assignment.evidenceIds });
  }
  const defaultRoutes = snapshot.routes?.filter((route) => route.destination === "default") ?? [];
  if (defaultRoutes.length) {
    nodes.push({ id: "network:internet", kind: "internet", role: "internet", label: "Internet", subtitle: "Default route", status: "unknown", confidence: "verified", addresses: [], evidenceIds: defaultRoutes.map((item) => item.evidenceId), metadata: {} });
    for (const route of defaultRoutes) {
      const gatewayAssignment = inventory.ipAssignments.find((item) => item.address === route.gateway);
      const source = gatewayAssignment?.deviceId ?? gatewayAssignment?.networkId;
      if (source) links.push({ id: `link:default-route:${safeId(source)}`, source, target: "network:internet", layer: "l3", relation: "default-route", confidence: "verified", label: "default route", evidenceIds: [route.evidenceId] });
    }
  }
}

function buildServices(inventory, nodes, links) {
  const assignmentById = new Map(inventory.ipAssignments.map((item) => [item.id, item]));
  const relevantDevices = new Set();
  const kubernetesNodes = inventory.devices.filter((item) => item.role === "kubernetes-node" && deviceVisible(item, inventory));
  let nodePortGroupAdded = false;
  const internal = inventory.services.filter((service) => service.addresses.length === 0 && service.kind === "kubernetes-clusterip");
  const external = inventory.services.filter((service) => !internal.includes(service));
  for (const service of external) {
    nodes.push(serviceNode(service));
    for (const address of service.addresses) {
      const assignment = assignmentById.get(`ip:${address}`);
      if (!assignment) continue;
      nodes.push(ipNode(assignment));
      links.push({ id: `link:service-vip:${safeId(service.id)}:${safeId(assignment.id)}`, source: assignment.id, target: service.id, layer: "service", relation: "serves", confidence: "verified", label: portLabel(service.ports), evidenceIds: service.evidenceIds });
      if (assignment.deviceId) {
        relevantDevices.add(assignment.deviceId);
        links.push({ id: `link:service-host:${safeId(assignment.deviceId)}:${safeId(assignment.id)}`, source: assignment.deviceId, target: assignment.id, layer: "service", relation: "hosts", confidence: assignment.confidence, label: "listens on", evidenceIds: assignment.evidenceIds });
      }
      for (const deviceId of assignment.advertisedByDeviceIds ?? []) {
        relevantDevices.add(deviceId);
        links.push({ id: `link:service-advertiser:${safeId(deviceId)}:${safeId(assignment.id)}`, source: deviceId, target: assignment.id, layer: "service", relation: "advertises", confidence: "strong", label: "announces VIP", evidenceIds: assignment.evidenceIds });
      }
    }
    if (service.ports.some((port) => port.nodePort)) {
      if (!nodePortGroupAdded) {
        nodes.push({
          id: "group:kubernetes-nodeports",
          kind: "group",
          role: "kubernetes-node-group",
          label: "Kubernetes nodes",
          subtitle: `${kubernetesNodes.length} NodePort endpoints`,
          status: kubernetesNodes.length ? "online" : "unknown",
          confidence: "verified",
          addresses: kubernetesNodes.flatMap((device) => addressesForDevice(device, inventory)),
          evidenceIds: unique(kubernetesNodes.flatMap((device) => device.evidenceIds)),
          metadata: { members: kubernetesNodes.map((device) => device.name || device.id).join(", ") },
        });
        nodePortGroupAdded = true;
      }
      links.push({
        id: `link:service-nodeport:${safeId(service.id)}`,
        source: "group:kubernetes-nodeports",
        target: service.id,
        layer: "service",
        relation: "node-port",
        confidence: "verified",
        label: service.ports.filter((port) => port.nodePort).map((port) => `${port.protocol ?? "TCP"}/${port.nodePort}`).join(", "),
        evidenceIds: service.evidenceIds,
      });
    }
  }
  nodes.push(...inventory.devices.filter((device) => relevantDevices.has(device.id) && deviceVisible(device, inventory)).map((device) => deviceNode(device, inventory)));
  return {
    groups: internal.length ? [{
      id: "group:internal-services",
      label: "Internal-only services",
      description: "ClusterIP-only services are collapsed to keep the external service path readable.",
      count: internal.length,
      collapsed: true,
      items: internal.map(serviceNode),
    }] : [],
  };
}

export function diffSnapshots(previous, current, overrides = {}, settings = {}) {
  if (!previous || !current) return { added: [], removed: [], changed: [], events: [] };
  const before = previous.inventory ?? withInventory(previous, overrides, settings).inventory;
  const after = current.inventory ?? withInventory(current, overrides, settings).inventory;
  const beforeDevices = new Map(before.devices.map((item) => [item.id, item]));
  const afterDevices = new Map(after.devices.map((item) => [item.id, item]));
  const added = [];
  const removed = [];
  const changed = [];
  const events = [];

  for (const [id, device] of afterDevices) {
    if (!beforeDevices.has(id)) {
      added.push(legacyDevice(device, after));
      events.push(event("device.added", id, `${device.name || id} was observed for the first time`));
      continue;
    }
    const old = beforeDevices.get(id);
    const fields = ["name", "role", "manufacturer", "model", "os"].filter((field) => (old[field] ?? null) !== (device[field] ?? null));
    const beforeAddresses = addressesForDevice(old, before);
    const afterAddresses = addressesForDevice(device, after);
    if (fields.length || !sameSet(beforeAddresses, afterAddresses)) {
      changed.push({ id, before: legacyDevice(old, before), after: legacyDevice(device, after), fields });
      if (fields.length) events.push(event("device.identity.changed", id, `${device.name || id}: updated ${fields.join(", ")}`));
      for (const address of afterAddresses.filter((value) => !beforeAddresses.includes(value))) events.push(event("ip.assigned", id, `${address} was assigned to ${device.name || id}`));
      for (const address of beforeAddresses.filter((value) => !afterAddresses.includes(value))) events.push(event("ip.removed", id, `${address} was removed from ${device.name || id}`));
    }
  }
  for (const [id, device] of beforeDevices) if (!afterDevices.has(id)) {
    removed.push(legacyDevice(device, before));
    events.push(event("device.removed", id, `${device.name || id} is no longer observed`));
  }
  diffEntitySet("service", before.services, after.services, events);
  diffEntitySet("link", before.links, after.links, events);
  return { added, removed, changed, events };
}

function deviceNode(device, inventory) {
  const addresses = inventory ? addressesForDevice(device, inventory) : [];
  return { id: device.id, kind: "device", role: device.role, label: device.name || device.suggestedName || addresses[0] || "Unnamed device", subtitle: addresses.join(", ") || [device.manufacturer, device.model].filter(Boolean).join(" · ") || device.role, status: device.status, confidence: device.identityConfidence, addresses, evidenceIds: device.evidenceIds, metadata: { manufacturer: device.manufacturer, model: device.model, os: device.os, sources: device.sourceKinds.join(", "), tags: device.tags.join(", "), identityReview: device.needsIdentityReview ? "Needs review" : null } };
}

function networkNode(network) { return { id: network.id, kind: "network", role: "network", label: network.name, subtitle: `${network.family.toUpperCase()} segment`, status: "online", confidence: "verified", addresses: [], evidenceIds: network.evidenceIds, metadata: { cidr: network.cidr } }; }
function ipNode(assignment) { return { id: assignment.id, kind: "ip", role: assignment.kind === "vip" ? "vip" : "address", label: assignment.address, subtitle: assignment.kind.toUpperCase(), status: "online", confidence: assignment.confidence, addresses: [assignment.address], evidenceIds: assignment.evidenceIds, metadata: { kind: assignment.kind, network: assignment.networkId } }; }
function serviceNode(service) { return { id: service.id, kind: "service", role: "service", label: service.name, subtitle: `${service.namespace} · ${service.kind}`, status: "online", confidence: "verified", addresses: service.addresses, evidenceIds: service.evidenceIds, metadata: { namespace: service.namespace, kind: service.kind, ports: portLabel(service.ports), clusterAddresses: service.clusterAddresses.join(", ") } }; }

function addressesForDevice(device, inventory) { const ids = new Set(device.ipAssignmentIds); return inventory.ipAssignments.filter((item) => ids.has(item.id) && item.deviceId === device.id && item.mapVisible !== false).map((item) => item.address).sort(); }
function deviceVisible(device, inventory) { const interfaces = inventory.interfaces.filter((item) => device.interfaceIds.includes(item.id)); return interfaces.length === 0 || interfaces.some((item) => item.mapVisible !== false); }
function legacyDevice(device, inventory) { const interfaceItems = inventory.interfaces.filter((item) => device.interfaceIds.includes(item.id)); return { ...device, addresses: addressesForDevice(device, inventory), mac: interfaceItems.find((item) => item.mac)?.mac ?? null, state: device.status }; }
function event(type, entityId, summary) { return { type, entityId, summary }; }
function diffEntitySet(kind, before, after, events) { const oldIds = new Set(before.map((item) => item.id)); const newIds = new Set(after.map((item) => item.id)); for (const item of after) if (!oldIds.has(item.id)) events.push(event(`${kind}.added`, item.id, `Added ${kind} ${item.name || item.label || item.id}`)); for (const item of before) if (!newIds.has(item.id)) events.push(event(`${kind}.removed`, item.id, `Removed ${kind} ${item.name || item.label || item.id}`)); }
function sameSet(a, b) { return a.length === b.length && a.every((item) => b.includes(item)); }
function deduplicateNodes(nodes) { return [...new Map(nodes.map((node) => [node.id, node])).values()]; }
function deduplicateLinks(links) { return [...new Map(links.map((link) => [link.id, link])).values()]; }
function unique(values) { return [...new Set(values)]; }
function portLabel(ports) { return ports?.length ? ports.map((item) => `${item.protocol ?? "TCP"}/${item.port}`).join(", ") : "service"; }
function safeId(value) { return encodeURIComponent(String(value)); }
function emptyTopology(view = "logical") { return { generatedAt: new Date().toISOString(), snapshotId: null, view, nodes: [], links: [], unplacedNodes: [], groups: [], coverage: null, confidenceCounts: { verified: 0, strong: 0, inferred: 0, weak: 0 }, legend: [] }; }
