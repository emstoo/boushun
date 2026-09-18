import test from "node:test";
import assert from "node:assert/strict";
import { collectDemo } from "../src/collectors/demo.js";
import { buildTopology, diffSnapshots } from "../src/topology/build-topology.js";

test("[TOP-16] demo topology preserves explicit link confidence and evidence", () => {
  const snapshot = collectDemo(() => new Date("2026-08-21T08:00:00.000Z"));
  const topology = buildTopology(snapshot);
  const switchLink = topology.links.find((link) => link.id === "link:demo:router-switch");

  assert.equal(switchLink.confidence, "verified");
  assert.deepEqual(switchLink.evidenceIds, ["evidence:demo:switch"]);
  assert.ok(topology.nodes.some((node) => node.id === "network:internet"));
  assert.ok(topology.links.some((link) => link.confidence === "weak"));
});

test("[TOP-07] snapshot diff identifies added, removed and changed devices", () => {
  const before = { devices: [
    { id: "a", name: "a", addresses: ["192.168.1.2"], state: "REACHABLE" },
    { id: "b", name: "b", addresses: ["192.168.1.3"], state: "REACHABLE" },
  ] };
  const after = { devices: [
    { id: "a", name: "a", addresses: ["192.168.1.20"], state: "REACHABLE" },
    { id: "c", name: "c", addresses: ["192.168.1.4"], state: "REACHABLE" },
  ] };
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.added.map((item) => item.id), ["c"]);
  assert.deepEqual(diff.removed.map((item) => item.id), ["b"]);
  assert.deepEqual(diff.changed.map((item) => item.id), ["a"]);
});

test("[TOP-01, TOP-02] physical view never invents placement links", () => {
  const snapshot = collectDemo(() => new Date("2026-08-21T08:00:00.000Z"));
  snapshot.explicitLinks = snapshot.explicitLinks.slice(0, 1);
  const topology = buildTopology(snapshot, { view: "physical" });
  assert.equal(topology.links.some((link) => link.relation === "unplaced"), false);
  assert.equal(topology.nodes.some((node) => node.id === "group:unplaced"), false);
  assert.ok(topology.unplacedNodes.length > 0);
  assert.equal(topology.coverage.total, topology.nodes.length + topology.unplacedNodes.length);
});

test("[TOP-04, INV-11] services view collapses internal-only services", () => {
  const snapshot = collectDemo();
  snapshot.kubernetes ||= { nodes: [], services: [] };
  snapshot.kubernetes.services.push({ name: "dns", namespace: "kube-system", kind: "kubernetes-clusterip", addresses: [], clusterAddresses: ["10.96.0.10"], ports: [{ protocol: "UDP", port: 53 }], evidenceIds: [] });
  const topology = buildTopology(snapshot, { view: "services" });
  assert.equal(topology.nodes.some((node) => node.label === "dns"), false);
  assert.equal(topology.groups[0].items[0].label, "dns");
});

test("[TOP-03] logical topology connects membership, VIP, advertiser, default route, and Internet", () => {
  const snapshot = collectDemo();
  snapshot.devices.find((device) => device.id === "device:router").addresses.push("192.168.50.99");
  snapshot.kubernetes = {
    nodes: [],
    services: [{
      name: "web",
      namespace: "default",
      kind: "kubernetes-loadbalancer",
      addresses: ["192.168.50.99"],
      clusterAddresses: ["10.96.0.10"],
      ports: [{ protocol: "TCP", port: 443 }],
      evidenceIds: ["evidence:k8s:service"],
    }],
  };
  const topology = buildTopology(snapshot, { view: "logical" });

  assert.ok(topology.nodes.some((node) => node.id === "network:internet"));
  assert.ok(topology.nodes.some((node) => node.id === "ip:192.168.50.99" && node.role === "vip"));
  for (const relation of ["address-membership", "virtual-address", "advertised-by", "default-route"]) {
    assert.ok(topology.links.some((link) => link.relation === relation), relation);
  }
});

test("[TOP-05] topology removes duplicate links and links with missing endpoints", () => {
  const snapshot = collectDemo();
  const valid = structuredClone(snapshot.explicitLinks[0]);
  snapshot.explicitLinks.push(
    structuredClone(valid),
    { id: "link:missing", source: "device:router", target: "device:missing", relation: "physical-or-l2", confidence: "verified", evidenceIds: [] },
  );
  const topology = buildTopology(snapshot, { view: "logical" });

  assert.equal(topology.nodes.length, new Set(topology.nodes.map((node) => node.id)).size);
  assert.equal(topology.links.filter((link) => link.id === valid.id).length, 1);
  assert.equal(topology.links.some((link) => link.id === "link:missing"), false);
  assert.ok(topology.links.every((link) => topology.nodes.some((node) => node.id === link.source)
    && topology.nodes.some((node) => node.id === link.target)));
});
