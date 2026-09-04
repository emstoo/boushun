import test from "node:test";
import assert from "node:assert/strict";
import { collectNetwork } from "../src/collectors/network.js";

const INTERFACES = [{
  ifindex: 2,
  ifname: "eth0",
  flags: ["BROADCAST", "UP"],
  mtu: 1500,
  operstate: "UP",
  address: "00:11:22:33:44:01",
  addr_info: [{ family: "inet", local: "192.168.44.1", prefixlen: 30, scope: "global" }],
}];
const ROUTES = [
  { dst: "default", gateway: "192.168.44.2", dev: "eth0", prefsrc: "192.168.44.1" },
  { dst: "192.168.44.0/30", dev: "eth0", scope: "link", prefsrc: "192.168.44.1" },
];
const NEIGHBORS = [{ dst: "192.168.44.2", dev: "eth0", lladdr: "00:11:22:33:44:02", state: ["REACHABLE"] }];

test("[COL-01, COL-12] network orchestration keeps active-only sources not-run for Passive collection", async () => {
  let discoveryCalls = 0;
  let snmpCalls = 0;
  const snapshot = await collectNetwork({
    profile: "passive",
    runner: fixtureRunner,
    textReader: async () => "nameserver 192.168.44.2\n",
    kubernetesCollector: emptyKubernetes,
    controllerCollector: async () => ({ devices: [], links: [], services: [], evidence: [], warnings: [] }),
    discoveryCollector: async () => { discoveryCalls += 1; return { mdns: [], ssdp: [], evidence: [], warnings: [] }; },
    snmpCollector: async () => { snmpCalls += 1; return { observations: [], evidence: [], warnings: [] }; },
    ouiPath: "/nonexistent/boushun-oui.csv",
  });

  assert.equal(discoveryCalls, 0);
  assert.equal(snmpCalls, 0);
  assert.equal(snapshot.sources.find((source) => source.id === "mdns").status, "not-run");
  assert.equal(snapshot.sources.find((source) => source.id === "snmpv3").status, "not-run");
});

test("[COL-11, EXT-06, EXT-14] Deep orchestration composes independent discovery, SNMP, and controller results", async () => {
  const snapshot = await collectNetwork({
    profile: "deep",
    cidr: "192.168.44.0/30",
    runner: fixtureRunner,
    textReader: async () => "nameserver 192.168.44.2\n",
    reverseLookup: async () => [],
    kubernetesCollector: emptyKubernetes,
    controllerCollector: async () => ({
      devices: [{ id: "device:controller", name: "Controller device", addresses: ["192.168.44.2"], evidenceIds: ["evidence:controller"] }],
      links: [
        { id: "link:controller", source: "device:self", target: "device:mac:00:11:22:33:44:02", confidence: "strong", evidenceIds: ["evidence:controller"] },
        { id: "link:missing", source: "device:self", target: "device:missing", confidence: "strong", evidenceIds: ["evidence:controller"] },
      ],
      services: [{ id: "service:controller", name: "Controller service", addresses: ["192.168.44.2"], ports: [{ protocol: "TCP", port: 443 }] }],
      evidence: [{ id: "evidence:controller", type: "controller-export", source: "fixture", observedAt: "2026-08-31T00:00:00.000Z", summary: "fixture", raw: null }],
      warnings: [],
    }),
    discoveryCollector: async () => ({
      mdns: [{ address: "192.168.44.2", hostname: "gateway.local", evidenceIds: ["evidence:mdns"] }],
      ssdp: [],
      evidence: [{ id: "evidence:mdns", type: "mdns-announcement", source: "mdns", observedAt: "2026-08-31T00:00:00.000Z", summary: "fixture", raw: null }],
      warnings: [],
    }),
    snmpTargets: [{ host: "192.168.44.2", user: "fixture", level: "noAuthNoPriv" }],
    snmpCollector: async () => ({
      observations: [{ target: "192.168.44.2", name: "switch", description: "test switch", interfaces: [], fdb: [], lldp: [], evidenceIds: ["evidence:snmp"] }],
      evidence: [{ id: "evidence:snmp", type: "snmp-topology", source: "snmpv3", observedAt: "2026-08-31T00:00:00.000Z", summary: "fixture", raw: null }],
      warnings: [],
    }),
    ouiPath: "/nonexistent/boushun-oui.csv",
  });

  assert.equal(snapshot.profile, "deep");
  assert.equal(snapshot.discovery.mdns.length, 1);
  assert.equal(snapshot.snmp.observations.length, 1);
  assert.equal(snapshot.controller.services.length, 1);
  assert.ok(snapshot.explicitLinks.some((link) => link.id === "link:controller"));
  assert.equal(snapshot.explicitLinks.some((link) => link.id === "link:missing"), false);
  assert.equal(snapshot.sources.find((source) => source.id === "snmpv3").status, "connected");
});

async function fixtureRunner(command, args) {
  const signature = `${command} ${args.join(" ")}`;
  if (signature === "ip -json address show") return { stdout: JSON.stringify(INTERFACES), stderr: "" };
  if (signature === "ip -json route show table main") return { stdout: JSON.stringify(ROUTES), stderr: "" };
  if (signature === "ip -json neigh show") return { stdout: JSON.stringify(NEIGHBORS), stderr: "" };
  if (command === "ping") return { stdout: "ok", stderr: "" };
  throw Object.assign(new Error(`Unexpected command: ${signature}`), { code: "ENOENT" });
}

async function emptyKubernetes() {
  return {
    available: false,
    nodes: [],
    services: [],
    evidence: [],
    warnings: [],
    source: { id: "kubernetes", label: "Kubernetes API", configured: false, status: "not-configured", recordCount: 0, message: "not configured" },
  };
}
