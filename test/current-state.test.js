import test from "node:test";
import assert from "node:assert/strict";
import { composeCurrentSnapshot } from "../src/domain/current-state.js";

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
