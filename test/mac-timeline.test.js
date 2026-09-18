import test from "node:test";
import assert from "node:assert/strict";
import { buildMacTimeline, buildMacTimelineIndex, isValidMacTimelineInput } from "../src/domain/mac-timeline.js";
import { isLocallyAdministeredMac, normalizeMac, normalizeMacInput } from "../src/domain/mac.js";

const MAC = "02:00:00:00:00:41";

test("[MTL-01] MAC normalization preserves collector compatibility and validates API forms", () => {
  assert.equal(normalizeMac("02.00.00.00.00.41"), MAC);
  assert.equal(normalizeMacInput(MAC.toUpperCase()), MAC);
  assert.equal(normalizeMacInput("02-00-00-00-00-41"), MAC);
  assert.equal(normalizeMacInput("020000000041"), MAC);
  assert.equal(normalizeMacInput("02.00.00.00.00.41"), null);
  assert.equal(normalizeMacInput("02:00:00:00:00"), null);
  assert.equal(isValidMacTimelineInput("not-a-mac"), false);
  assert.equal(isLocallyAdministeredMac(MAC), true);
  assert.equal(isLocallyAdministeredMac("00:11:22:33:44:55"), false);
});

test("[MTL-02, MTL-03, MTL-07, MTL-08] timeline uses explicit per-snapshot MAC observations and qualified changes", () => {
  const snapshots = [
    snapshot("2026-09-01T00:00:00.000Z", [{ id: "device:ip:192.168.50.40", addresses: ["192.168.50.40"], mac: null }]),
    snapshot("2026-09-02T00:00:00.000Z", [{ id: `device:mac:${MAC}`, addresses: ["192.168.50.40"], mac: MAC }]),
    snapshot("2026-09-03T00:00:00.000Z", [{ id: "device:other", addresses: ["192.168.50.99"], mac: "02:00:00:00:00:99" }]),
    snapshot("2026-09-04T00:00:00.000Z", [{ id: `device:mac:${MAC}`, addresses: ["192.168.50.41"], mac: MAC }], {
      scan: {
        method: "icmp-echo", cidr: "192.168.50.0/24", targetCount: 1, responsiveCount: 1,
        probes: [{ address: "192.168.50.41", result: "response", observedAt: "2026-09-04T00:00:01.000Z", evidenceId: "evidence:response" }],
      },
      evidence: [{ id: "evidence:response", type: "icmp-response", source: "icmp", observedAt: "2026-09-04T00:00:01.000Z", sourceObservedAt: "2026-09-04T00:00:01.000Z" }],
    }),
  ];
  const original = structuredClone(snapshots);
  const timeline = buildMacTimeline(snapshots, "02-00-00-00-00-41");

  assert.equal(timeline.mac, MAC);
  assert.equal(timeline.entries.length, 2);
  assert.deepEqual(timeline.entries.map((entry) => entry.snapshot.observedAt), ["2026-09-02T00:00:00.000Z", "2026-09-04T00:00:00.000Z"]);
  assert.deepEqual(timeline.entries[1].branches[0].changesSincePreviousObservation.addressesAdded, ["192.168.50.41"]);
  assert.deepEqual(timeline.entries[1].branches[0].changesSincePreviousObservation.addressesNoLongerRepresented, ["192.168.50.40"]);
  assert.equal(timeline.entries[1].branches[0].lastResponseAt, "2026-09-04T00:00:01.000Z");
  assert.equal(timeline.entries[1].branches[0].responses[0].method, "icmp-echo");
  assert.deepEqual(snapshots, original);
});

test("[MTL-04, MTL-05, MTL-06] a split MAC remains separate projected branches", () => {
  const raw = snapshot("2026-09-05T00:00:00.000Z", [{
    id: `device:mac:${MAC}`, addresses: ["192.168.50.40", "192.168.50.41"], mac: MAC, name: "Shared device",
  }]);
  const overrides = {
    devices: {}, merges: [], audit: [],
    splits: [{ sourceId: `device:mac:${MAC}`, targetId: "device:manual:camera", addresses: ["192.168.50.41"], name: "Camera" }],
  };
  const timeline = buildMacTimeline([raw], MAC, overrides);

  assert.deepEqual(timeline.entries[0].branches.map((branch) => branch.deviceId), ["device:manual:camera", `device:mac:${MAC}`]);
  assert.equal(timeline.summary.branchCount, 2);
  assert.equal(timeline.summary.needsIdentityReview, true);
  assert.deepEqual(timeline.entries[0].branches.find((branch) => branch.deviceId === "device:manual:camera").addresses, ["192.168.50.41"]);
});

test("[MTL-06] a merge target stays stable when snapshots contain one member at a time", () => {
  const sourceId = "device:merge:source";
  const targetId = "device:merge:target";
  const snapshots = [
    snapshot("2026-09-05T00:00:00.000Z", [{ id: sourceId, addresses: ["192.168.50.40"], mac: MAC, name: "Source" }]),
    snapshot("2026-09-06T00:00:00.000Z", [{ id: targetId, addresses: ["192.168.50.41"], mac: MAC, name: "Target" }]),
  ];
  const overrides = {
    devices: {}, splits: [], audit: [],
    merges: [{ sourceIds: [targetId, sourceId], targetId, name: "Merged device" }],
  };
  const timeline = buildMacTimeline(snapshots, MAC, overrides);

  assert.deepEqual(timeline.entries.map((entry) => entry.branches.map((branch) => branch.deviceId)), [[targetId], [targetId]]);
  assert.equal(timeline.summary.branchCount, 1);
  assert.equal(timeline.summary.needsIdentityReview, false);
  assert.equal(timeline.entries[1].branches[0].changesSincePreviousObservation.previousObservedAt, "2026-09-05T00:00:00.000Z");
});

test("[MTL-10, MTL-14] index and detail expose bounded retained-history metadata", () => {
  const snapshots = [snapshot("2026-09-02T00:00:00.000Z", [{ id: `device:mac:${MAC}`, addresses: ["192.168.50.41"], mac: MAC, name: "Camera" }])];
  const index = buildMacTimelineIndex(snapshots, {}, {}, { maximumSnapshotCount: 10 });

  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].preferredLabel, "Camera");
  assert.deepEqual(index.retention, {
    retainedSnapshotCount: 1,
    oldestRetainedAt: "2026-09-02T00:00:00.000Z",
    newestRetainedAt: "2026-09-02T00:00:00.000Z",
    maximumSnapshotCount: 10,
  });
  assert.equal(buildMacTimeline(snapshots, "not-a-mac"), null);
  assert.equal(buildMacTimeline(snapshots, "02:00:00:00:00:42"), null);
});

test("[MTL-09] timeline scopes and deduplicates every direct response method", () => {
  const raw = snapshot("2026-09-07T00:00:00.000Z", [{
    id: `device:mac:${MAC}`, addresses: ["192.168.50.41"], mac: MAC, name: "Camera",
  }], {
    observationChecks: [
      {
        method: "icmp-echo", snapshotId: "responses", retrievedAt: "2026-09-07T00:00:00.000Z",
        responses: [
          { method: "icmp-echo", address: "192.168.50.41", respondedAt: "2026-09-07T00:00:01.000Z", evidenceIds: ["evidence:icmp"] },
          { method: "icmp-echo", address: "192.168.50.41", respondedAt: "2026-09-07T00:00:01.000Z", evidenceIds: ["evidence:icmp"] },
        ],
      },
      ...["snmpv3", "mdns", "ssdp"].map((method) => ({
        method, snapshotId: "responses", retrievedAt: "2026-09-07T00:00:00.000Z",
        responses: [{ method, address: "192.168.50.41", respondedAt: "2026-09-07T00:00:02.000Z", evidenceIds: [`evidence:${method}`] }],
      })),
      ...[["tcp-connect", 443], ["udp-probe", 5683]].map(([method, port]) => ({
        method, snapshotId: "responses", retrievedAt: "2026-09-07T00:00:00.000Z",
        responses: [{ method, address: "192.168.50.41", port, respondedAt: "2026-09-07T00:00:03.000Z", evidenceIds: [`evidence:${method}`] }],
      })),
    ],
  });
  const responses = buildMacTimeline([raw], MAC).entries[0].branches[0].responses;

  assert.deepEqual(responses.map((item) => item.method).sort(), ["icmp-echo", "mdns", "snmpv3", "ssdp", "tcp-connect", "udp-probe"]);
  assert.equal(responses.filter((item) => item.method === "icmp-echo").length, 1);
  assert.equal(responses.find((item) => item.method === "tcp-connect").port, 443);
  assert.equal(responses.find((item) => item.method === "udp-probe").port, 5683);
  assert.ok(responses.every((item) => item.address === "192.168.50.41" && item.evidenceIds.length === 1));
});

test("[MTL-15] timeline projection excludes credential-like raw source fields", () => {
  const marker = "TEST_TIMELINE_CREDENTIAL_MARKER_DO_NOT_EXPOSE";
  const raw = snapshot("2026-09-08T00:00:00.000Z", [{
    id: `device:mac:${MAC}`, addresses: ["192.168.50.41"], mac: MAC, name: "Camera", credential: marker,
  }], {
    evidence: [{ id: "evidence:secret-source", type: "source", raw: { token: marker } }],
  });
  const timeline = buildMacTimeline([raw], MAC);

  assert.ok(timeline.entries.length > 0);
  assert.doesNotMatch(JSON.stringify(timeline), new RegExp(marker));
});

function snapshot(observedAt, devices, extra = {}) {
  return {
    id: `snapshot:${observedAt}`,
    observedAt,
    profile: "passive",
    interfaces: [], routes: [], sources: [], warnings: [],
    devices: devices.map((device) => ({
      name: null, role: "host", state: "REACHABLE", interface: "eth0", identityConfidence: device.mac ? "strong" : "weak",
      evidenceIds: [], source: "neighbor-cache", ...device,
    })),
    evidence: [],
    ...extra,
    evidence: [...(extra.evidence ?? [])],
  };
}
