import test from "node:test";
import assert from "node:assert/strict";
import { collectDemo } from "../src/collectors/demo.js";
import { buildInventory } from "../src/domain/inventory.js";
import { buildTopology, diffSnapshots } from "../src/topology/build-topology.js";

test("[INV-20, OBS-03] Kubernetes adds missing node addresses to an existing identity without confirming responses", () => {
  const snapshot = {
    id: "synthetic-node-addresses", observedAt: "2026-09-17T01:00:00.000Z", profile: "passive", interfaces: [],
    devices: [{ id: "device:existing", addresses: ["192.168.50.2"], mac: "02:00:00:00:00:02",
      source: "neighbor-cache", state: "STALE", evidenceIds: ["evidence:neighbor"] }],
    evidence: [{ id: "evidence:neighbor", type: "neighbor-cache" }, { id: "evidence:node", type: "kubernetes-node" }],
    kubernetes: { available: true, nodes: [{ name: "node.test", addresses: ["192.168.50.2", "192.168.50.3", "192.168.50.3"],
      roles: ["worker"], conditions: [{ type: "Ready", status: "True" }], evidenceIds: ["evidence:node"] }], services: [] },
  };
  const original = structuredClone(snapshot);
  const inventory = buildInventory(snapshot);
  assert.equal(inventory.devices.length, 1);
  const device = inventory.devices[0];
  assert.equal(device.id, "device:existing");
  assert.equal(device.name, "node.test");
  assert.equal(device.role, "kubernetes-node");
  assert.deepEqual(inventory.ipAssignments.map((item) => item.address).sort(), ["192.168.50.2", "192.168.50.3"]);
  for (const assignment of inventory.ipAssignments) {
    assert.equal(assignment.deviceId, device.id);
    assert.ok(device.ipAssignmentIds.includes(assignment.id));
    assert.equal(assignment.observation.kind, "registered");
    assert.equal(assignment.observation.lastResponseAt, null);
  }
  assert.ok(inventory.ipAssignments.find((item) => item.address === "192.168.50.3").evidenceIds.includes("evidence:node"));
  assert.equal(device.observation.kind, "registered");
  assert.equal(device.observation.lastResponseAt, null);
  assert.deepEqual(device.reportedConditions, snapshot.kubernetes.nodes[0].conditions);
  assert.deepEqual(buildInventory(snapshot), inventory);
  assert.deepEqual(snapshot, original);
});

test("[INV-10, INV-11] Kubernetes LoadBalancer address becomes a VIP rather than a node address", () => {
  const snapshot = collectDemo(() => new Date("2026-08-21T08:00:00Z"));
  snapshot.devices.find((device) => device.id === "device:router").addresses.push("192.168.50.99");
  snapshot.kubernetes = {
    nodes: [{ name: "boushun-node", addresses: ["192.168.50.1"], roles: ["worker"], evidenceIds: ["evidence:k8s:node"] }],
    services: [{ name: "web", namespace: "default", kind: "kubernetes-loadbalancer", addresses: ["192.168.50.99"], clusterAddresses: ["10.96.0.10"], ports: [{ protocol: "TCP", port: 443 }], evidenceIds: ["evidence:k8s:service"] }],
  };
  const inventory = buildInventory(snapshot);
  const vip = inventory.ipAssignments.find((item) => item.address === "192.168.50.99");

  assert.equal(vip.kind, "vip");
  assert.equal(vip.deviceId, null);
  assert.deepEqual(vip.advertisedByDeviceIds, ["device:router"]);
  assert.equal(inventory.devices.find((item) => item.id === "device:router").role, "kubernetes-node");
  const serviceTopology = buildTopology({ ...snapshot, inventory }, { view: "services" });
  assert.ok(serviceTopology.nodes.some((node) => node.role === "service"));
  assert.ok(serviceTopology.links.some((link) => link.relation === "advertises"));
});

test("[INV-04, INV-16] manual split changes the projection without changing raw observations", () => {
  const snapshot = collectDemo();
  const source = snapshot.devices.find((device) => device.id === "device:laptop");
  source.addresses.push("192.168.50.102");
  const inventory = buildInventory(snapshot, { devices: {}, merges: [], splits: [{ sourceId: source.id, targetId: "device:manual:phone", addresses: ["192.168.50.102"], name: "phone" }] });
  assert.equal(snapshot.devices.find((device) => device.id === source.id).addresses.length, 2);
  assert.equal(inventory.ipAssignments.find((item) => item.address === "192.168.50.102").deviceId, "device:manual:phone");
});

test("[INV-05] real scanner interfaces replace synthetic addresses and omit loopback", () => {
  const snapshot = collectDemo();
  const scanner = snapshot.devices.find((item) => item.id === "device:self");
  scanner.addresses = ["192.168.50.250"];
  scanner.interface = "synthetic0";
  snapshot.interfaces = [
    { name: "lo", state: "UP", addresses: [{ address: "127.0.0.1", cidr: "127.0.0.0/8" }] },
    { name: "eth0", state: "UP", mac: scanner.mac, addresses: [{ address: "192.168.50.200", cidr: "192.168.50.0/24", evidenceId: "evidence:local" }] },
  ];
  const inventory = buildInventory(snapshot);
  const projected = inventory.devices.find((item) => item.id === "device:self");

  assert.deepEqual(projected.interfaceIds, ["interface:self:eth0"]);
  assert.deepEqual(
    inventory.ipAssignments.filter((item) => item.deviceId === projected.id).map((item) => item.address),
    ["192.168.50.200"],
  );
  assert.equal(inventory.interfaces.some((item) => item.name === "lo" || item.name === "synthetic0"), false);
});

test("[INV-15] merge rewrites device, interface, assignment, and advertiser references without changing raw data", () => {
  const snapshot = collectDemo();
  const laptop = snapshot.devices.find((item) => item.id === "device:laptop");
  laptop.addresses.push("192.168.50.99");
  snapshot.kubernetes = {
    nodes: [],
    services: [{
      name: "merged-vip",
      namespace: "default",
      kind: "kubernetes-loadbalancer",
      addresses: ["192.168.50.99"],
      clusterAddresses: [],
      ports: [{ protocol: "TCP", port: 443 }],
      evidenceIds: ["evidence:vip"],
    }],
  };
  const original = structuredClone(snapshot);
  const inventory = buildInventory(snapshot, {
    devices: {}, splits: [], audit: [],
    merges: [{ sourceIds: ["device:router", "device:laptop"], targetId: "device:router", name: "Merged edge" }],
  });
  const merged = inventory.devices.find((item) => item.id === "device:router");

  assert.equal(merged.name, "Merged edge");
  assert.equal(inventory.devices.some((item) => item.id === "device:laptop"), false);
  assert.ok(inventory.interfaces.filter((item) => merged.interfaceIds.includes(item.id)).every((item) => item.deviceId === merged.id));
  assert.ok(inventory.ipAssignments
    .filter((item) => merged.ipAssignmentIds.includes(item.id) && item.kind !== "vip")
    .every((item) => item.deviceId === merged.id));
  const vip = inventory.ipAssignments.find((item) => item.address === "192.168.50.99");
  assert.equal(vip.deviceId, null);
  assert.deepEqual(vip.advertisedByDeviceIds, [merged.id]);
  assert.deepEqual(snapshot, original);
});

test("[INV-16] a split after a merge applies in audit order", () => {
  const snapshot = collectDemo();
  const merge = { id: "merge:ordered", sourceIds: ["device:nas", "device:camera"], targetId: "device:nas" };
  const split = { id: "split:ordered", sourceId: "device:nas", targetId: "device:camera-split", addresses: ["192.168.50.41"], name: "camera-split.demo.test" };
  const inventory = buildInventory(snapshot, {
    devices: {}, merges: [merge], splits: [split],
    audit: [
      { action: "device.merge", details: merge },
      { action: "device.split", details: split },
    ],
  });
  const target = inventory.devices.find((device) => device.id === "device:camera-split");
  assert.equal(target.name, "camera-split.demo.test");
  assert.equal(inventory.ipAssignments.find((assignment) => assignment.address === "192.168.50.41").deviceId, target.id);
  assert.equal(inventory.ipAssignments.find((assignment) => assignment.address === "192.168.50.30").deviceId, "device:nas");
});

test("[INV-16] persistent operation order survives audit truncation", () => {
  const snapshot = collectDemo();
  const merge = {
    id: "merge:persistent-order",
    sequence: 1,
    sourceIds: ["device:nas", "device:camera"],
    targetId: "device:nas",
  };
  const split = {
    id: "split:persistent-order",
    sequence: 2,
    sourceId: "device:nas",
    targetId: "device:camera-split",
    addresses: ["192.168.50.41"],
    name: "camera-split.demo.test",
  };
  const inventory = buildInventory(snapshot, {
    devices: {}, merges: [merge], splits: [split],
    audit: Array.from({ length: 500 }, (_, index) => ({ action: "device.override", details: { id: `device:${index}` } })),
  });

  assert.equal(
    inventory.ipAssignments.find((assignment) => assignment.address === "192.168.50.41").deviceId,
    "device:camera-split",
  );
  assert.equal(inventory.ipAssignments.find((assignment) => assignment.address === "192.168.50.30").deviceId, "device:nas");
});

test("[TOP-07] neighbor state churn is not a meaningful change", () => {
  const before = collectDemo();
  const after = structuredClone(before);
  after.devices[1].state = "STALE";
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.events, []);
});

test("[INV-06, INV-07] interface identity and map policies suppress virtual-network noise", () => {
  const snapshot = collectDemo();
  snapshot.devices.push({ id: "device:virtual", addresses: ["172.17.0.2"], interface: "docker0", state: "REACHABLE", role: "host", evidenceIds: [] });
  const inventory = buildInventory(snapshot, {}, { interfaces: { docker0: { map: false, identity: false, scan: false } } });
  assert.equal(inventory.devices.some((item) => item.id === "device:virtual"), false);
});

test("[INV-08, INV-13] a TCP response creates an address-only service identity with review guidance", () => {
  const snapshot = collectDemo();
  snapshot.tcpServices = { endpoints: [{ address: "192.168.50.222", port: 8080, protocol: "tcp", service: "http-alt", evidenceIds: ["evidence:tcp"] }] };
  const inventory = buildInventory(snapshot);
  const device = inventory.devices.find((item) => item.id === "device:ip:192.168.50.222");
  const service = inventory.services.find((item) => item.id === "service:tcp:192.168.50.222:8080");
  assert.equal(device.status, "responded");
  assert.equal(device.sourceKinds.includes("tcp-connect"), true);
  assert.equal(device.identityConfidence, "inferred");
  assert.equal(device.identityIssues[0].code, "address-only-identity");
  assert.equal(device.identityIssues[0].severity, "info");
  assert.match(device.suggestedName, /192\.168\.50\.222/);
  assert.equal(service.kind, "tcp-service");
  const topology = buildTopology({ ...snapshot, inventory }, { view: "services" });
  assert.ok(topology.links.some((item) => item.relation === "hosts" && item.source === device.id));
});

test("[INV-08, INV-09] only a confirmed UDP response creates a service", () => {
  const snapshot = collectDemo();
  snapshot.udpServices = {
    endpoints: [{ address: "192.168.50.223", port: 5683, protocol: "udp", state: "open", service: "coap", evidenceIds: ["evidence:udp"] }],
    uncertainEndpoints: [{ address: "192.168.50.224", port: 9999, protocol: "udp", state: "open-or-filtered", service: "udp-9999", evidenceIds: ["evidence:summary"] }],
  };
  const inventory = buildInventory(snapshot);
  const confirmed = inventory.services.find((item) => item.id === "service:udp:192.168.50.223:5683");
  assert.equal(confirmed.kind, "udp-service");
  assert.equal(confirmed.ports[0].protocol, "UDP");
  assert.equal(inventory.devices.find((item) => item.id === "device:ip:192.168.50.223").sourceKinds.includes("udp-probe"), true);
  assert.equal(inventory.services.some((item) => item.id === "service:udp:192.168.50.224:9999"), false);
});

test("[INV-12] a neighbor-cache MAC spanning many addresses is flagged instead of presented as certain", () => {
  const snapshot = collectDemo();
  snapshot.devices.push({
    id: "device:mac:02:00:00:00:00:18",
    addresses: ["192.168.50.2", "192.168.50.8", "192.168.50.15"],
    mac: "02:00:00:00:00:18",
    name: null,
    manufacturer: "BUFFALO.INC",
    role: "host",
    state: "REACHABLE",
    interface: "eth0",
    identityConfidence: "strong",
    evidenceIds: [],
    source: "neighbor-cache",
  });
  const inventory = buildInventory(snapshot);
  const device = inventory.devices.find((item) => item.id === "device:mac:02:00:00:00:00:18");
  assert.equal(device.needsIdentityReview, true);
  assert.equal(device.identityIssues[0].code, "shared-mac-multiple-addresses");
  assert.equal(device.identityConfidence, "conflicted");
  assert.deepEqual(device.identityIssues[0].recommendedAction, {
    type: "split-addresses",
    keepAddress: "192.168.50.2",
    addresses: ["192.168.50.8", "192.168.50.15"],
  });
  assert.equal(device.suggestedName, "BUFFALO.INC group · 3 addresses");

  const splitInventory = buildInventory(snapshot, {
    devices: {},
    merges: [],
    audit: [],
    splits: device.identityIssues[0].recommendedAction.addresses.map((address) => ({
      sourceId: device.id,
      targetId: `device:manual:${address}`,
      addresses: [address],
      name: address,
    })),
  });
  assert.deepEqual(
    splitInventory.devices.filter((item) => item.id.startsWith("device:manual:")).map((item) => item.name).sort(),
    ["192.168.50.15", "192.168.50.8"],
  );
  assert.equal(splitInventory.devices.find((item) => item.id === device.id).needsIdentityReview, false);
});
