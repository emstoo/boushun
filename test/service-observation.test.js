import test from "node:test";
import assert from "node:assert/strict";
import { buildComparableServiceChanges } from "../src/domain/service-observation.js";

test("[TOP-08, TOP-09] service changes compare only scans with the same protocol, scope, and ports", () => {
  const first = {
    id: "first",
    observedAt: "2026-08-22T00:00:00.000Z",
    tcpServices: {
      method: "tcp-connect",
      cidr: "192.168.50.0/24",
      ports: [80, 443],
      endpoints: [
        { address: "192.168.50.10", port: 80 },
        { address: "192.168.50.20", port: 443 },
      ],
    },
  };
  const differentCoverage = {
    id: "different",
    tcpServices: {
      method: "tcp-connect",
      cidr: "192.168.50.10/32",
      ports: [80, 443],
      endpoints: [],
    },
  };
  const latest = {
    id: "latest",
    tcpServices: {
      method: "tcp-connect",
      cidr: "192.168.50.0/24",
      ports: [443, 80],
      endpoints: [
        { address: "192.168.50.10", port: 80 },
        { address: "192.168.50.30", port: 443 },
      ],
    },
  };

  const changes = buildComparableServiceChanges([first, differentCoverage, latest], latest, "tcp");
  assert.equal(changes.comparable, true);
  assert.equal(changes.previousSnapshotId, "first");
  assert.deepEqual(changes.added, [{ address: "192.168.50.30", port: 443 }]);
  assert.deepEqual(changes.removed, [{ address: "192.168.50.20", port: 443 }]);
  assert.equal(changes.unchangedCount, 1);
});

test("[TOP-08] first coverage is a baseline rather than reporting every port as new", () => {
  const latest = {
    id: "latest",
    udpServices: {
      method: "udp-probe",
      cidr: "192.168.50.0/24",
      ports: [53],
      endpoints: [{ address: "192.168.50.1", port: 53 }],
    },
  };
  assert.deepEqual(buildComparableServiceChanges([latest], latest, "udp"), {
    comparable: false,
    previousSnapshotId: null,
    previousObservedAt: null,
    added: [],
    removed: [],
    unchangedCount: 0,
  });
});
