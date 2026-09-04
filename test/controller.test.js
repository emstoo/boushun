import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectControllerSnapshots } from "../src/collectors/controller.js";

test("[EXT-06, EXT-08, API-11] controller exports retain schema fields without exposing out-of-schema markers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-controller-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const exportPath = path.join(directory, "controller.json");
  const marker = "TEST_SECRET_MARKER_DO_NOT_EXPOSE";
  await writeFile(exportPath, JSON.stringify({
    token: marker,
    devices: [{
      id: "device:ap-1",
      name: "AP",
      mac: "00:11:22:33:44:55",
      addresses: ["192.168.50.20"],
      role: "access-point",
      vendorCredential: marker,
    }],
    links: [{ source: "device:switch-1", target: "device:ap-1", relation: "controller-uplink", privateData: marker }],
    services: [{ id: "service:web", name: "Web", ports: [{ protocol: "TCP", port: 443 }], password: marker }],
  }));

  const result = await collectControllerSnapshots([exportPath], "2026-08-31T00:00:00.000Z");
  assert.equal(result.devices[0].name, "AP");
  assert.equal(result.links[0].relation, "controller-uplink");
  assert.equal(result.services[0].ports[0].port, 443);
  assert.equal(result.evidence[0].raw.devices[0].vendorCredential, undefined);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
});

test("[EXT-07] malformed controller fields do not discard valid fields or other files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-controller-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const partialPath = path.join(directory, "partial.json");
  const malformedPath = path.join(directory, "malformed.json");
  await writeFile(partialPath, JSON.stringify({ devices: {}, links: [{ source: "device:a", target: "device:b" }], services: [] }));
  await writeFile(malformedPath, "{");

  const result = await collectControllerSnapshots([partialPath, malformedPath], "2026-08-31T00:00:00.000Z");
  assert.equal(result.devices.length, 0);
  assert.equal(result.links.length, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /devices must be an array/);
});
