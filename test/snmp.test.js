import test from "node:test";
import assert from "node:assert/strict";
import { collectSnmp, normalizeObservation } from "../src/collectors/snmp.js";

test("[EXT-11] SNMP tables normalize interfaces, FDB entries and LLDP neighbors", () => {
  const observation = normalizeObservation({ host: "192.168.1.10" }, {
    system: [
      { oid: "1.3.6.1.2.1.1.1.0", value: Buffer.from("Test switch") },
      { oid: "1.3.6.1.2.1.1.5.0", value: Buffer.from("switch-1") },
    ],
    interfaces: [
      { oid: "1.3.6.1.2.1.31.1.1.1.1.8", value: Buffer.from("lan8") },
      { oid: "1.3.6.1.2.1.31.1.1.1.6.8", value: Buffer.from([0, 17, 34, 51, 68, 85]) },
    ],
    bridgePorts: [{ oid: "1.3.6.1.2.1.17.1.4.1.2.4", value: 8 }],
    fdb: [
      { oid: "1.3.6.1.2.1.17.4.3.1.1.170.187.204.221.238.255", value: Buffer.from([170, 187, 204, 221, 238, 255]) },
      { oid: "1.3.6.1.2.1.17.4.3.1.2.170.187.204.221.238.255", value: 4 },
    ],
    lldpRemote: [
      { oid: "1.0.8802.1.1.2.1.4.1.1.5.0.8.1", value: Buffer.from([0, 17, 34, 51, 68, 102]) },
      { oid: "1.0.8802.1.1.2.1.4.1.1.9.0.8.1", value: Buffer.from("ap-1") },
    ],
  });
  assert.equal(observation.name, "switch-1");
  assert.equal(observation.interfaces[0].name, "lan8");
  assert.equal(observation.fdb[0].interfaceIndex, 8);
  assert.equal(observation.lldp[0].systemName, "ap-1");
});

test("[EXT-12, EXT-13, API-11] SNMP failures close sessions and redact configured keys from warnings", async () => {
  const authKey = "TEST_AUTH_MARKER_DO_NOT_EXPOSE";
  const privKey = "TEST_PRIV_MARKER_DO_NOT_EXPOSE";
  let closeCount = 0;
  const session = {
    subtree(_oid, _maxRepetitions, _feed, done) {
      done(new Error(`request failed: {"authKey":"${authKey}","privKey":"${privKey}"}`));
    },
    close() {
      closeCount += 1;
    },
  };

  const result = await collectSnmp({
    targets: [{ host: "192.168.1.10", user: "boushun", level: "authPriv", authKey, privKey }],
    createSession: () => session,
  });

  assert.equal(closeCount, 1);
  assert.equal(result.observations.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${authKey}|${privKey}`));
  assert.match(result.warnings[0], /\[redacted\]/);
});

test("[EXT-10] incomplete SNMPv3 targets are rejected before a session is created", async () => {
  let sessions = 0;
  const createSession = () => {
    sessions += 1;
    throw new Error("must not create a session");
  };
  for (const target of [
    null,
    { host: "192.168.1.10" },
    { host: "192.168.1.10", user: "boushun", level: "authNoPriv" },
    { host: "192.168.1.10", user: "boushun", level: "authPriv", authKey: "configured" },
  ]) {
    await assert.rejects(collectSnmp({ targets: [target], createSession }), /requires host and user|authKey is required|privKey is required/);
  }
  assert.equal(sessions, 0);
});
