import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { collectTcpServices, connectTcp, parseCustomPorts, resolveTcpServicePorts, tcpServicePresets } from "../src/collectors/tcp-services.js";

test("[TCP-01, TCP-02, TCP-03] custom TCP ports normalize input and enforce the 64-port boundary", () => {
  assert.deepEqual(parseCustomPorts("443, 8000-8002,443"), [443, 8000, 8001, 8002]);
  assert.throws(() => parseCustomPorts("0"), /Invalid TCP port/);
  assert.throws(() => parseCustomPorts("65536"), /Invalid TCP port/);
  assert.throws(() => parseCustomPorts("9-1"), /Invalid TCP port range/);
  assert.throws(() => parseCustomPorts("text"), /Invalid TCP port/);
  assert.throws(() => parseCustomPorts("1-100"), /too large/);
  assert.throws(() => parseCustomPorts("1".repeat(1_001)), /too long/);
  const maximum = Array.from({ length: 64 }, (_, index) => index + 1).join(",");
  const excess = Array.from({ length: 65 }, (_, index) => index + 1).join(",");
  assert.equal(resolveTcpServicePorts("custom", maximum).length, 64);
  assert.throws(() => resolveTcpServicePorts("custom", excess), /64 unique ports/);
  assert.throws(() => resolveTcpServicePorts("unknown", "80"), /Unknown TCP service preset/);
  assert.throws(() => resolveTcpServicePorts("custom", ""), /at least one custom TCP port/);
});

test("[TCP-09] Kubernetes preset includes only NodePorts observed through the API", () => {
  const snapshot = { kubernetes: { services: [{ ports: [{ nodePort: 32080 }, { port: 443 }] }] } };
  assert.ok(tcpServicePresets(snapshot).find((item) => item.id === "kubernetes").ports.includes(32080));
  assert.deepEqual(resolveTcpServicePorts("custom", "8080,8443", snapshot), [8080, 8443]);
});

test("[TCP-05, TCP-07] TCP service discovery checks every usable IP without ICMP gating", async () => {
  const attempts = [];
  const connector = async (address, port) => {
    attempts.push(`${address}:${port}`);
    return { state: address === "192.168.50.2" && port === 443 ? "open" : "closed", latencyMs: 2 };
  };
  const result = await collectTcpServices({
    cidr: "192.168.50.0/30",
    allowedCIDRs: ["192.168.50.0/24"],
    ports: [80, 443],
    connector,
    observedAt: "2026-08-21T00:00:00.000Z",
  });

  assert.deepEqual(attempts.sort(), ["192.168.50.1:443", "192.168.50.1:80", "192.168.50.2:443", "192.168.50.2:80"].sort());
  assert.equal(result.targetCount, 2);
  assert.equal(result.attemptCount, 4);
  assert.equal(result.openCount, 1);
  assert.deepEqual(result.endpoints[0], {
    address: "192.168.50.2",
    port: 443,
    protocol: "tcp",
    service: "https",
    latencyMs: 2,
    evidenceIds: [result.endpoints[0].evidenceIds[0]],
  });
  assert.equal(result.outcomeCounts.closed, 3);
  assert.equal(result.source.status, "connected");
});

test("[NET-03, NET-05, TCP-04] invalid TCP scope or port limits open zero connections", async () => {
  let calls = 0;
  const connector = async () => {
    calls += 1;
    return { state: "closed" };
  };
  await assert.rejects(collectTcpServices({ cidr: "192.168.0.0/23", ports: [80], connector }), /\/24/);
  await assert.rejects(collectTcpServices({
    cidr: "192.168.50.0/24",
    allowedCIDRs: ["192.168.50.0/25"],
    ports: [80],
    connector,
  }), /BOUSHUN_ALLOWED_CIDRS/);
  await assert.rejects(collectTcpServices({
    cidr: "192.168.50.0/24",
    ports: Array.from({ length: 65 }, (_, index) => index + 1),
    allowedCIDRs: ["192.168.50.0/24"],
    connector,
  }), /64 unique ports/);
  assert.equal(calls, 0);
});

test("[TCP-04] maximum valid TCP coverage remains deterministic and within the hard attempt limit", async () => {
  let calls = 0;
  const result = await collectTcpServices({
    cidr: "192.168.50.0/24",
    ports: Array.from({ length: 64 }, (_, index) => index + 1),
    allowedCIDRs: ["192.168.50.0/24"],
    connector: async () => {
      calls += 1;
      return { state: "closed" };
    },
  });
  assert.equal(result.targetCount, 254);
  assert.equal(result.portCount, 64);
  assert.equal(calls, result.attemptCount);
  assert.equal(result.attemptCount, result.targetCount * result.portCount);
});

test("[TCP-08] TCP service discovery cancellation prevents a partial result", async () => {
  const controller = new AbortController();
  const connector = async (_address, _port, { signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    signal.addEventListener("abort", abort, { once: true });
  });
  const pending = collectTcpServices({ cidr: "192.168.50.0/30", allowedCIDRs: ["192.168.50.0/24"], ports: [80], connector, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("[TCP-07] TCP connector closes an accepted connection without application payload", async (t) => {
  let receivedBytes = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => { receivedBytes += chunk.length; });
    socket.on("close", resolveClosed);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await connectTcp("127.0.0.1", server.address().port, { timeoutMs: 500 });
  await closed;
  assert.equal(result.state, "open");
  assert.equal(receivedBytes, 0);
});
