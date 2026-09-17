import test from "node:test";
import assert from "node:assert/strict";
import { composeCurrentSnapshot } from "../src/domain/current-state.js";
import { buildInventory } from "../src/domain/inventory.js";

function snapshot(id, profile, extra = {}) {
  return {
    id,
    profile,
    observedAt: `2026-08-22T00:0${id}:00.000Z`,
    devices: [{
      id: "device:mac:aa:bb:cc:dd:ee:ff",
      mac: "aa:bb:cc:dd:ee:ff",
      addresses: ["192.168.50.10"],
      name: null,
      role: "host",
      identityConfidence: "strong",
      evidenceIds: [`evidence:${id}:device`],
      source: "neighbor-cache",
    }],
    interfaces: [],
    evidence: [{ id: `evidence:${id}`, observedAt: `2026-08-22T00:0${id}:00.000Z` }],
    explicitLinks: [],
    discovery: { dhcp: [], mdns: [], ssdp: [] },
    sources: [],
    warnings: [],
    summary: {},
    ...extra,
  };
}

test("[COL-12, INV-02, INV-04] current state retains the latest dataset from every scan workflow", () => {
  const deep = snapshot("1", "deep", {
    devices: [
      {
        id: "device:mac:aa:bb:cc:dd:ee:ff",
        mac: "aa:bb:cc:dd:ee:ff",
        addresses: ["192.168.50.10"],
        name: "printer.local",
        role: "host",
        identityConfidence: "strong",
        evidenceIds: ["evidence:deep-device"],
        source: "neighbor-cache",
        sourceKinds: ["mdns"],
      },
      {
        id: "device:ip:192.168.50.20",
        mac: null,
        addresses: ["192.168.50.20"],
        name: null,
        role: "host",
        identityConfidence: "verified",
        evidenceIds: ["evidence:icmp-device"],
        source: "icmp-echo",
      },
    ],
    scan: { method: "icmp-echo", cidr: "192.168.50.0/24", responsiveCount: 2 },
    discovery: { dhcp: [], mdns: [{ address: "192.168.50.10", name: "printer.local" }], ssdp: [] },
    snmp: { targetCount: 1, observations: [{ target: "192.168.50.1" }] },
    explicitLinks: [{ id: "link:lldp", source: "device:router", target: "device:switch" }],
    sources: [
      { id: "icmp", status: "connected", recordCount: 2 },
      { id: "mdns", status: "connected", recordCount: 1 },
      { id: "ssdp", status: "connected", recordCount: 0 },
      { id: "snmpv3", status: "connected", recordCount: 1 },
    ],
  });
  const tcp = snapshot("2", "tcp-services", {
    tcpServices: {
      method: "tcp-connect",
      cidr: "192.168.50.0/24",
      openCount: 1,
      openHostCount: 1,
      endpoints: [{ address: "192.168.50.10", port: 443, evidenceIds: ["evidence:tcp"] }],
    },
    sources: [{ id: "tcp-services", status: "connected", recordCount: 1 }],
  });
  const udp = snapshot("3", "udp-services", {
    udpServices: {
      method: "udp-probe",
      cidr: "192.168.50.0/24",
      openCount: 1,
      openHostCount: 1,
      uncertainCount: 0,
      endpoints: [{ address: "192.168.50.10", port: 53, evidenceIds: ["evidence:udp"] }],
    },
    sources: [
      { id: "local-network", status: "connected", recordCount: 3 },
      { id: "icmp", status: "not-run", recordCount: 0 },
      { id: "tcp-services", status: "not-run", recordCount: 0 },
      { id: "udp-services", status: "connected", recordCount: 1 },
    ],
  });

  const current = composeCurrentSnapshot([deep, tcp, udp]);

  assert.equal(current.profile, "current");
  assert.equal(current.sourceProfile, "udp-services");
  assert.equal(current.scan.method, "icmp-echo");
  assert.equal(current.tcpServices.endpoints[0].port, 443);
  assert.equal(current.udpServices.endpoints[0].port, 53);
  assert.equal(current.discovery.mdns[0].name, "printer.local");
  assert.equal(current.snmp.observations.length, 1);
  assert.equal(current.explicitLinks[0].id, "link:lldp");
  assert.equal(current.devices.find((device) => device.id.endsWith("ee:ff")).name, "printer.local");
  assert.ok(current.devices.some((device) => device.id === "device:ip:192.168.50.20"));
  assert.equal(current.sources.find((source) => source.id === "icmp").status, "connected");
  assert.equal(current.sources.find((source) => source.id === "tcp-services").status, "connected");
  assert.equal(current.sources.find((source) => source.id === "udp-services").status, "connected");
  assert.equal(current.composition.sources["tcp-services"].snapshotId, "2");
  assert.equal(udp.profile, "udp-services");
  assert.equal(udp.tcpServices, undefined);
});

test("[TOP-10] current state can be projected at any point in history", () => {
  const passive = snapshot("1", "passive", {
    sources: [{ id: "local-network", status: "connected", recordCount: 1 }],
  });
  const tcp = snapshot("2", "tcp-services", {
    tcpServices: { method: "tcp-connect", openCount: 0, openHostCount: 0, endpoints: [] },
    sources: [{ id: "tcp-services", status: "connected", recordCount: 0 }],
  });
  const laterPassive = snapshot("3", "passive", {
    sources: [
      { id: "local-network", status: "connected", recordCount: 1 },
      { id: "tcp-services", status: "not-run", recordCount: 0 },
    ],
  });

  assert.equal(composeCurrentSnapshot([passive]).tcpServices, null);
  assert.equal(composeCurrentSnapshot([passive, tcp]).tcpServices.method, "tcp-connect");
  assert.equal(composeCurrentSnapshot([passive, tcp, laterPassive]).tcpServices.method, "tcp-connect");
});

test("[INV-18] local refresh replaces self configuration while preserving other observations and history", () => {
  const self = (address) => ({ id: "device:self", role: "scanner", source: "local-interface",
    addresses: [address], mac: "02:00:00:00:00:01", interface: "eth0", evidenceIds: ["evidence:local"] });
  const localInterface = (address) => ({ name: "eth0", state: "UP", mac: "02:00:00:00:00:01",
    addresses: [{ address, cidr: "192.168.50.0/24", evidenceId: "evidence:local" }] });
  const earlier = snapshot("1", "deep", {
    devices: [self("192.168.50.10"), { id: "device:remote", addresses: ["192.168.50.30"], source: "icmp-echo", evidenceIds: ["evidence:reply"] }],
    interfaces: [localInterface("192.168.50.10")],
    scan: { method: "icmp-echo", cidr: "192.168.50.30/32", probes: [
      { address: "192.168.50.30", result: "response", observedAt: "2026-08-22T00:01:00.000Z", evidenceId: "evidence:reply" },
    ] },
  });
  const local = snapshot("2", "local", {
    devices: [self("192.168.50.20")], interfaces: [localInterface("192.168.50.20")],
    routes: [{ destination: "default", gateway: "192.168.50.1", interface: "eth0" }],
    scanCandidates: ["192.168.50.0/24"],
  });
  const history = [earlier, local];
  const original = structuredClone(history);
  const current = composeCurrentSnapshot(history);
  assert.deepEqual(current.devices.find((device) => device.id === "device:self").addresses, ["192.168.50.20"]);
  assert.deepEqual(current.interfaces, local.interfaces);
  assert.deepEqual(current.routes, local.routes);
  assert.deepEqual(current.scanCandidates, local.scanCandidates);
  const inventory = buildInventory(current);
  assert.deepEqual(inventory.ipAssignments.filter((item) => item.deviceId === "device:self").map((item) => item.address), ["192.168.50.20"]);
  assert.equal(inventory.devices.find((device) => device.id === "device:remote").observation.lastResponseAt, earlier.observedAt);
  assert.deepEqual(composeCurrentSnapshot([earlier]).devices.find((device) => device.id === "device:self").addresses, ["192.168.50.10"]);
  assert.deepEqual(history, original);
});

test("[INV-19, OBS-06] local refresh retains DNS and DHCP data with their source provenance until the next passive update", () => {
  const passive = snapshot("1", "passive", {
    resolver: ["192.168.50.53"],
    discovery: { dhcp: [{ address: "192.168.50.30", hostname: "leased.test", evidenceIds: ["evidence:lease"] }], mdns: [], ssdp: [] },
    evidence: [{ id: "evidence:lease", type: "dhcp-lease", observedAt: "2026-08-22T00:01:00.000Z" }],
    sources: [{ id: "dns-config", status: "connected", recordCount: 1 }, { id: "dhcp-leases", status: "connected", recordCount: 1 }],
  });
  const local = snapshot("2", "local", { devices: [], resolver: [],
    sources: [{ id: "local-network", status: "connected", recordCount: 1 }] });
  const refreshed = snapshot("3", "passive", { resolver: [],
    sources: [{ id: "dns-config", status: "connected", recordCount: 0 }, { id: "dhcp-leases", status: "connected", recordCount: 0 }] });
  const history = [passive, local, refreshed];
  const original = structuredClone(history);
  const current = composeCurrentSnapshot(history.slice(0, 2));
  assert.deepEqual(current.resolver, passive.resolver);
  assert.deepEqual(current.discovery.dhcp, passive.discovery.dhcp);
  assert.ok(current.evidence.some((record) => record.id === "evidence:lease"));
  for (const id of ["dns-config", "dhcp-leases"]) {
    const source = current.sources.find((item) => item.id === id);
    assert.equal(source.status, "connected");
    assert.equal(source.recordCount, 1);
    assert.equal(source.observedAt, passive.observedAt);
    assert.equal(source.snapshotId, passive.id);
  }
  const updated = composeCurrentSnapshot(history);
  assert.deepEqual(updated.resolver, []);
  assert.deepEqual(updated.discovery.dhcp, []);
  for (const id of ["dns-config", "dhcp-leases"]) {
    const source = updated.sources.find((item) => item.id === id);
    assert.equal(source.recordCount, 0);
    assert.equal(source.observedAt, refreshed.observedAt);
    assert.equal(source.snapshotId, refreshed.id);
  }
  assert.deepEqual(history, original);
});
