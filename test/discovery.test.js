import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { collectDiscovery, discoverSsdp } from "../src/collectors/discovery.js";

test("[EXT-09] multicast collection preserves successful data when another source fails", async () => {
  const result = await collectDiscovery({
    observedAt: "2026-08-31T00:00:00.000Z",
    discoverSsdp: async () => [{ address: "192.168.1.20", name: "device", source: "ssdp" }],
    discoverMdns: async () => { throw new Error("socket unavailable"); },
  });
  assert.equal(result.ssdp.length, 1);
  assert.equal(result.mdns.length, 0);
  assert.equal(result.evidence.length, 1);
  assert.match(result.warnings[0], /mDNS discovery failed: socket unavailable/);
});

test("[EXT-09] SSDP ignores malformed and duplicate replies and closes its socket", async () => {
  let closeCount = 0;
  class FakeSocket extends EventEmitter {
    bind(_port, callback) { callback(); }
    send(_query, _port, _host, callback) {
      const response = Buffer.from("HTTP/1.1 200 OK\r\nSERVER: test-device\r\nST: upnp:rootdevice\r\n\r\n");
      const remote = { address: "192.168.1.20" };
      this.emit("message", response, remote);
      this.emit("message", response, remote);
      this.emit("message", Buffer.from("malformed"), remote);
      callback(new Error("finish test socket"));
    }
    close() { closeCount += 1; }
  }

  const records = await discoverSsdp({ timeout: 1, createSocket: () => new FakeSocket() });
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "test-device");
  assert.equal(closeCount, 1);
});

test("[EXT-09] an already-aborted discovery does not create or send on a socket", async () => {
  const controller = new AbortController();
  controller.abort();
  let sockets = 0;
  const records = await discoverSsdp({
    signal: controller.signal,
    createSocket: () => {
      sockets += 1;
      throw new Error("must not create socket");
    },
  });
  assert.deepEqual(records, []);
  assert.equal(sockets, 0);
});
