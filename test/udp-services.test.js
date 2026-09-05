import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import {
  collectUdpServices,
  createPacer,
  parseCustomUdpPorts,
  probeUdp,
  resolveUdpServicePorts,
  udpProbeForPort,
  udpServicePresets,
} from "../src/collectors/udp-services.js";

test("[UDP-01, UDP-02, UDP-03] UDP ports enforce normalization, exclusions, and the 16-port boundary", () => {
  assert.ok(udpServicePresets().some((item) => item.id === "safe-common"));
  assert.deepEqual(parseCustomUdpPorts("53,8123,9000-9002"), [53, 8123, 9000, 9001, 9002]);
  assert.deepEqual(resolveUdpServicePorts("iot", "8123"), [1900, 5683, 8123]);
  assert.throws(() => parseCustomUdpPorts("70000"), /Invalid UDP port/);
  assert.throws(() => parseCustomUdpPorts("9-1"), /Invalid UDP port range/);
  assert.throws(() => parseCustomUdpPorts("text"), /Invalid UDP port/);
  assert.throws(() => parseCustomUdpPorts("1-17"), /range is too large/);
  assert.throws(() => parseCustomUdpPorts("1".repeat(1_001)), /too long/);
  const maximum = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].join(",");
  const excess = `${maximum},17`;
  assert.equal(resolveUdpServicePorts("custom", maximum).length, 16);
  assert.throws(() => resolveUdpServicePorts("custom", excess), /16 unique ports/);
  assert.throws(() => resolveUdpServicePorts("unknown", "53"), /Unknown UDP service preset/);
  assert.throws(() => resolveUdpServicePorts("custom", ""), /at least one custom UDP port/);
  for (const port of [67, 68, 161, 162, 3702, 5353]) {
    assert.throws(() => resolveUdpServicePorts("custom", String(port)), new RegExp(`UDP port ${port} is excluded`));
  }
});

test("[UDP-05, UDP-10] UDP discovery checks every usable IP and separates uncertain results", async () => {
  const calls = [];
  const result = await collectUdpServices({
    cidr: "192.168.50.0/30",
    ports: [53, 9999],
    allowedCIDRs: ["192.168.50.0/24"],
    retryCount: 0,
    rateLimitPerSecond: 1_000,
    prober: async (address, port) => {
      calls.push(`${address}:${port}`);
      if (address === "192.168.50.1" && port === 53) return { state: "open", identifiedService: true, latencyMs: 2, responseBytes: 24 };
      if (address === "192.168.50.1" && port === 9999) return { state: "open-or-filtered" };
      return { state: "closed" };
    },
  });
  assert.deepEqual(calls.sort(), ["192.168.50.1:53", "192.168.50.1:9999", "192.168.50.2:53", "192.168.50.2:9999"]);
  assert.equal(result.attemptCount, 4);
  assert.equal(result.transmissionCount, 4);
  assert.equal(result.openCount, 1);
  assert.equal(result.uncertainCount, 1);
  assert.equal(result.endpoints[0].service, "dns");
  assert.equal(result.uncertainEndpoints[0].state, "open-or-filtered");
  assert.equal(result.outcomeCounts.closed, 2);
});

test("[NET-03, NET-05, UDP-03] invalid UDP scope or port limits send zero datagrams", async () => {
  let calls = 0;
  const prober = async () => {
    calls += 1;
    return { state: "closed" };
  };
  await assert.rejects(collectUdpServices({ cidr: "192.168.0.0/23", ports: [53], prober }), /\/24/);
  await assert.rejects(collectUdpServices({
    cidr: "192.168.50.0/24",
    allowedCIDRs: ["192.168.50.0/25"],
    ports: [53],
    prober,
  }), /BOUSHUN_ALLOWED_CIDRS/);
  await assert.rejects(collectUdpServices({ cidr: "192.168.50.0/24", allowedCIDRs: ["192.168.50.0/24"], ports: [161], prober }), /excluded/);
  await assert.rejects(collectUdpServices({
    cidr: "192.168.50.0/24",
    ports: Array.from({ length: 17 }, (_, index) => index + 1),
    allowedCIDRs: ["192.168.50.0/24"],
    prober,
  }), /16 unique ports/);
  assert.equal(calls, 0);
});

test("[UDP-08] UDP pacing caps configured rates at 50 datagrams per second", async () => {
  let current = 0;
  const delays = [];
  const waitForPermit = createPacer(1_000, {
    now: () => current,
    delay: async (milliseconds) => {
      delays.push(milliseconds);
      current += milliseconds;
    },
  });
  await waitForPermit();
  await waitForPermit();
  await waitForPermit();
  assert.deepEqual(delays, [0, 1_000 / 50, 1_000 / 50]);
});

test("[UDP-06] UDP discovery retries only a timeout", async () => {
  const counts = new Map();
  const result = await collectUdpServices({
    cidr: "192.168.50.0/30",
    ports: [9999],
    allowedCIDRs: ["192.168.50.0/24"],
    retryCount: 1,
    retryDelayMs: -250,
    rateLimitPerSecond: 1_000,
    prober: async (address) => {
      const count = (counts.get(address) ?? 0) + 1;
      counts.set(address, count);
      if (address === "192.168.50.1" && count === 1) return { state: "open-or-filtered" };
      if (address === "192.168.50.1") return { state: "open", identifiedService: false };
      return { state: "closed" };
    },
  });
  assert.equal(result.transmissionCount, 3);
  assert.equal(result.openCount, 1);
  assert.equal(counts.get("192.168.50.2"), 1);
});

test("[UDP-07] two UDP timeouts remain uncertain and never create a confirmed endpoint", async () => {
  const result = await collectUdpServices({
    cidr: "192.168.50.7/32",
    ports: [9999],
    allowedCIDRs: ["192.168.50.0/24"],
    retryCount: 1,
    retryDelayMs: -250,
    rateLimitPerSecond: 1_000,
    prober: async () => ({ state: "open-or-filtered" }),
  });
  assert.equal(result.transmissionCount, 2);
  assert.equal(result.openCount, 0);
  assert.equal(result.uncertainCount, 1);
  assert.deepEqual(result.endpoints, []);
});

test("[UDP-09] UDP discovery cancellation prevents a partial result", async () => {
  const controller = new AbortController();
  await assert.rejects(collectUdpServices({
    cidr: "192.168.50.0/30",
    ports: [53, 123],
    allowedCIDRs: ["192.168.50.0/24"],
    retryCount: 0,
    rateLimitPerSecond: 1_000,
    signal: controller.signal,
    prober: async () => ({ state: "closed" }),
    onProgress: ({ completed }) => {
      if (completed === 1) controller.abort();
    },
  }), { name: "AbortError" });
});

test("[UDP-04, UDP-05] protocol-specific UDP probes validate matching responses", () => {
  const dns = udpProbeForPort(53);
  const dnsResponse = Buffer.from(dns.payload);
  dnsResponse[2] |= 0x80;
  assert.equal(dns.validate(dnsResponse), true);

  const ntp = udpProbeForPort(123);
  const ntpResponse = Buffer.alloc(48);
  ntpResponse[0] = 0x24;
  assert.equal(ntp.validate(ntpResponse), true);

  const netbios = udpProbeForPort(137);
  const netbiosResponse = Buffer.from(netbios.payload);
  netbiosResponse[2] |= 0x80;
  assert.equal(netbios.validate(netbiosResponse), true);

  const ssdp = udpProbeForPort(1900);
  assert.equal(ssdp.validate(Buffer.from("HTTP/1.1 200 OK\r\n\r\n")), true);

  const coap = udpProbeForPort(5683);
  assert.equal(coap.validate(Buffer.from([0x60, 0x45, 0x00, 0x01])), true);
});

test("[UDP-05] UDP prober accepts a datagram response as confirmed open", async (t) => {
  const server = dgram.createSocket("udp4");
  await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  server.on("message", (_message, remote) => server.send(Buffer.from("reply"), remote.port, remote.address));
  const result = await probeUdp("127.0.0.1", server.address().port, { timeoutMs: 500 });
  assert.equal(result.state, "open");
  assert.equal(result.responseBytes, 5);
});
