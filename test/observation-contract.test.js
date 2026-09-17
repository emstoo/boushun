import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectNetwork } from "../src/collectors/network.js";
import { collectLinux } from "../src/collectors/linux.js";
import { collectControllerSnapshots } from "../src/collectors/controller.js";
import { collectKubernetes } from "../src/collectors/kubernetes.js";
import { buildInventory } from "../src/domain/inventory.js";
import { composeCurrentSnapshot } from "../src/domain/current-state.js";
import { buildTopologyViews } from "../src/topology/build-topology.js";

const OLD = "2026-09-01T00:00:00.000Z";
const RESPONSE = "2026-09-17T01:00:00.000Z";
const LATER = "2026-09-17T02:00:00.000Z";
const ADDRESS = "192.168.50.2";
const NEIGHBOR = { dst: ADDRESS, dev: "eth0", lladdr: "02:00:00:00:00:02", state: ["STALE"] };
const INTERFACES = [{ ifname: "eth0", address: "02:00:00:00:00:01", operstate: "UP", addr_info: [{ family: "inet", local: "192.168.50.1", prefixlen: 30 }] }];

function fixture(time = LATER, extra = {}) {
  return {
    id: `snapshot:${time}`, observedAt: time, profile: "passive", interfaces: [], routes: [],
    devices: [{ id: "device:cached", addresses: [ADDRESS], mac: NEIGHBOR.lladdr, state: "STALE", source: "neighbor-cache", evidenceIds: ["evidence:cache"] }],
    evidence: [{ id: "evidence:cache", type: "neighbor-cache", observedAt: time, retrievedAt: time, sourceObservedAt: null, raw: NEIGHBOR }],
    sources: [], warnings: [], ...extra,
  };
}
function checked(time = RESPONSE, result = "response", address = ADDRESS) {
  return fixture(time, {
    profile: "standard",
    scan: { method: "icmp-echo", cidr: `${address}/32`, targetCount: 1, responsiveCount: result === "response" ? 1 : 0,
      probes: [{ address, result, observedAt: time, evidenceId: `probe:${time}:${address}` }] },
    evidence: [{ id: `probe:${time}:${address}`, type: `probe-${result}`, source: "icmp-echo", observedAt: time, raw: { address, result, observedAt: time } }],
  });
}
function runner(commands, neighbors = [NEIGHBOR], ping = async () => ({ stdout: "", stderr: "" })) {
  return async (command, args) => {
    commands.push([command, ...args]);
    if (command === "ping") return ping();
    if (command === "ip" && args[1] === "address") return { stdout: JSON.stringify(INTERFACES) };
    if (command === "ip" && args[1] === "route") return { stdout: "[]" };
    if (command === "ip" && args[1] === "neigh") return { stdout: JSON.stringify(neighbors) };
    throw new Error("Unexpected OS command");
  };
}

test("[LOC-01] local configuration does not access inventory sources or probe", async () => {
  const commands = [];
  const forbidden = async () => { assert.fail("Local configuration accessed an inventory source"); };
  const snapshot = await collectNetwork({ profile: "local", runner: runner(commands), textReader: forbidden,
    reverseLookup: forbidden, kubernetesCollector: forbidden, controllerCollector: forbidden,
    discoveryCollector: forbidden, snmpCollector: forbidden, allowedCIDRs: ["192.168.50.0/30"] });
  assert.deepEqual(commands, [["ip", "-json", "address", "show"], ["ip", "-json", "route", "show", "table", "main"]]);
  assert.deepEqual(snapshot.devices.map((device) => device.id), ["device:self"]);
  assert.deepEqual(snapshot.scanCandidates, ["192.168.50.0/30"]);
  assert.equal(snapshot.scan, null);
  assert.equal(snapshot.evidence.some((item) => item.type === "neighbor-cache"), false);
});

test("[OBS-01] cache states remain candidates excluded from topology", () => {
  for (const state of ["STALE", "REACHABLE", "PERMANENT", "NOARP", "DELAY", "PROBE", "INCOMPLETE"]) {
    const raw = fixture();
    raw.devices[0].state = state;
    const device = buildInventory(raw).devices[0];
    assert.equal(device.observation.kind, "candidate", state);
    assert.equal(device.observation.lastResponseAt, null, state);
    assert.equal(device.status, "unconfirmed", state);
    for (const topology of Object.values(buildTopologyViews(raw))) {
      assert.equal([...topology.nodes, ...topology.unplacedNodes].some((node) => node.id === device.id), false, state);
    }
  }
});

test("[OBS-02] unchanged controller data has stable identity and an honest source time", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-observation-controller-"));
  const file = path.join(directory, "synthetic.json");
  const document = { observedAt: OLD, devices: [{ id: "device:controller", addresses: [ADDRESS], state: "UP" }] };
  await writeFile(file, JSON.stringify(document));
  const before = await readFile(file, "utf8");
  const first = await collectControllerSnapshots([file], RESPONSE);
  const second = await collectControllerSnapshots([file], LATER);
  assert.equal(first.evidence[0].id, second.evidence[0].id);
  assert.equal(second.evidence[0].retrievedAt, LATER);
  assert.equal(second.evidence[0].sourceObservedAt, OLD);
  assert.equal(await readFile(file, "utf8"), before);
  for (const sourceTime of [undefined, "invalid", "2099-01-01T00:00:00.000Z"]) {
    await writeFile(file, JSON.stringify({ ...document, observedAt: sourceTime }));
    const result = await collectControllerSnapshots([file], LATER);
    assert.equal(result.evidence[0].sourceObservedAt, null);
  }
});

test("[OBS-03] Kubernetes reported state is separate from response evidence", async () => {
  const result = await collectKubernetes({ observedAt: LATER, api: {
    listNode: async () => ({ items: [{ metadata: { name: "node.test", uid: "synthetic-node" }, status: {
      addresses: [{ type: "InternalIP", address: ADDRESS }], conditions: [{ type: "Ready", status: "Unknown", lastHeartbeatTime: OLD }],
    } }] }), listServiceForAllNamespaces: async () => ({ items: [] }),
  } });
  assert.equal(result.nodes[0].conditions[0].status, "Unknown");
  const inventory = buildInventory(fixture(LATER, { kubernetes: result, evidence: result.evidence }));
  assert.equal(inventory.devices[0].observation.kind, "registered");
  assert.equal(inventory.devices[0].observation.lastResponseAt, null);
  assert.notEqual(inventory.devices[0].status, "online");
});

test("[OBS-04] ICMP response creates an address without a cache entry and timestamps the reply", async () => {
  let clock = OLD;
  const snapshot = await collectLinux({ profile: "standard", cidr: "192.168.50.0/30", allowedCIDRs: ["192.168.50.0/30"],
    runner: runner([], [], async () => { clock = RESPONSE; return { stdout: "" }; }), textReader: async () => "",
    reverseLookup: async () => [], now: () => new Date(clock) });
  const inventory = buildInventory(snapshot);
  const assignment = inventory.ipAssignments.find((item) => item.address === ADDRESS);
  assert.ok(assignment);
  const device = inventory.devices.find((item) => item.id === assignment.deviceId);
  assert.equal(device.observation.kind, "response");
  assert.equal(device.observation.lastResponseAt, RESPONSE);
  assert.equal(snapshot.scan.probes[0].observedAt, RESPONSE);
});

test("[OBS-04, OBS-08] one address response does not confirm every address on a merged device", () => {
  const raw = checked();
  raw.devices[0].addresses.push("192.168.50.3");
  const inventory = buildInventory(raw);
  assert.deepEqual(inventory.devices[0].observation.responses.map((item) => item.address), [ADDRESS]);
  assert.equal(inventory.ipAssignments.find((item) => item.address === "192.168.50.3").observation.kind, "candidate");
});

test("[OBS-05, OBS-06, OBS-11] a successful recheck replaces its scope while unrelated results keep their times", () => {
  const first = checked();
  const noResponse = checked(LATER, "timeout");
  const rawHistory = structuredClone([first, noResponse]);
  let inventory = buildInventory(composeCurrentSnapshot([first, noResponse, fixture("2026-09-17T03:00:00.000Z")]));
  assert.equal(inventory.devices.find((item) => item.id === "device:cached").observation.kind, "candidate");
  inventory = buildInventory(composeCurrentSnapshot([first, checked(LATER, "timeout", "192.168.50.3"), fixture("2026-09-17T03:00:00.000Z")]));
  assert.equal(inventory.devices.find((item) => item.id === "device:cached").observation.lastResponseAt, RESPONSE);
  assert.equal(buildInventory(composeCurrentSnapshot([first])).devices[0].observation.lastResponseAt, RESPONSE);
  assert.deepEqual([first, noResponse], rawHistory);
});

test("[OBS-07] a probe execution failure is not a timeout or a successful empty check", async () => {
  await assert.rejects(collectLinux({ profile: "standard", cidr: "192.168.50.0/30", allowedCIDRs: ["192.168.50.0/30"],
    runner: runner([], [], async () => { throw Object.assign(new Error("Cannot execute probe"), { code: "ENOENT" }); }),
    textReader: async () => "", reverseLookup: async () => [] }), /probe|ping|ENOENT/i);
});

test("[OBS-09] forwarding evidence does not confirm the learned endpoint", () => {
  const raw = fixture(LATER, { snmp: { observations: [{ target: "192.168.50.10", observedAt: RESPONSE,
    fdb: [{ mac: NEIGHBOR.lladdr }], lldp: [], evidenceIds: ["evidence:snmp"] }] } });
  assert.equal(buildInventory(raw).devices.find((item) => item.id === "device:cached").observation.kind, "candidate");
});
