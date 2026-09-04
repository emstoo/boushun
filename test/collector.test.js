import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseDefaultScanCIDR,
  collectLinux,
  parseInterfaces,
  parseNeighbors,
  parseRoutes,
  parseLeaseDocument,
} from "../src/collectors/linux.js";

const ADDRESS_FIXTURE = [
  {
    ifindex: 1,
    ifname: "lo",
    flags: ["LOOPBACK", "UP"],
    mtu: 65536,
    operstate: "UNKNOWN",
    address: "00:00:00:00:00:00",
    addr_info: [{ family: "inet", local: "127.0.0.1", prefixlen: 8, scope: "host" }],
  },
  {
    ifindex: 2,
    ifname: "eth0",
    flags: ["BROADCAST", "UP"],
    mtu: 1500,
    operstate: "UP",
    address: "02:42:c0:a8:2c:01",
    addr_info: [{ family: "inet", local: "192.168.44.1", prefixlen: 30, scope: "global" }],
  },
];

const ROUTE_FIXTURE = [
  { dst: "default", gateway: "192.168.44.2", dev: "eth0", protocol: "dhcp", prefsrc: "192.168.44.1", metric: 100 },
  { dst: "192.168.44.0/30", dev: "eth0", protocol: "kernel", scope: "link", prefsrc: "192.168.44.1" },
];

const NEIGHBOR_FIXTURE = [
  { dst: "192.168.44.2", dev: "eth0", lladdr: "AA-BB-CC-DD-EE-02", state: ["REACHABLE"] },
  { dst: "192.168.44.3", dev: "eth0", state: ["FAILED"] },
];

test("[COL-04, COL-05] iproute2 fixtures are normalized", () => {
  const interfaces = parseInterfaces(ADDRESS_FIXTURE);
  const routes = parseRoutes(ROUTE_FIXTURE);
  const neighbors = parseNeighbors(NEIGHBOR_FIXTURE);

  assert.equal(interfaces[1].addresses[0].cidr, "192.168.44.0/30");
  assert.equal(chooseDefaultScanCIDR(interfaces), "192.168.44.0/30");
  assert.equal(chooseDefaultScanCIDR(interfaces, { interfaces: { eth0: { scan: false } } }), null);
  assert.equal(routes[0].gateway, "192.168.44.2");
  assert.equal(neighbors.length, 1);
  assert.equal(neighbors[0].mac, "aa:bb:cc:dd:ee:02");
});

test("[COL-06] dnsmasq, ISC and Kea lease formats are normalized", () => {
  assert.equal(parseLeaseDocument("123 aa:bb:cc:dd:ee:ff 192.168.1.2 phone *")[0].hostname, "phone");
  assert.equal(parseLeaseDocument('lease 192.168.1.3 { hardware ethernet aa:bb:cc:dd:ee:01; client-hostname "tablet"; }')[0].hostname, "tablet");
  assert.equal(parseLeaseDocument('[{"ip-address":"192.168.1.4","hw-address":"aa:bb:cc:dd:ee:02","hostname":"tv"}]')[0].address, "192.168.1.4");
});

test("[COL-08, COL-09] standard collection probes only the validated host range and records evidence", async () => {
  let neighborReads = 0;
  const commands = [];
  const runner = async (command, args) => {
    commands.push([command, ...args]);
    const signature = `${command} ${args.join(" ")}`;
    if (signature === "ip -json address show") return { stdout: JSON.stringify(ADDRESS_FIXTURE), stderr: "" };
    if (signature === "ip -json route show table main") return { stdout: JSON.stringify(ROUTE_FIXTURE), stderr: "" };
    if (signature === "ip -json neigh show") {
      neighborReads += 1;
      return { stdout: JSON.stringify(neighborReads === 1 ? [] : NEIGHBOR_FIXTURE), stderr: "" };
    }
    if (command === "ping" && args.at(-1) === "192.168.44.2") return { stdout: "ok", stderr: "" };
    throw Object.assign(new Error(`Unexpected command: ${signature}`), { code: "ENOENT" });
  };
  const textReader = async (filePath) => {
    if (filePath === "/etc/resolv.conf") return "nameserver 192.168.44.2\n";
    throw Object.assign(new Error("not found"), { code: "ENOENT" });
  };

  const snapshot = await collectLinux({
    profile: "standard",
    cidr: "192.168.44.0/30",
    runner,
    textReader,
    reverseLookup: async () => ["gateway.home.arpa."],
    now: () => new Date("2026-08-21T08:00:00.000Z"),
  });

  assert.equal(snapshot.scan.targetCount, 1);
  assert.equal(snapshot.scan.responsiveCount, 1);
  assert.equal(snapshot.devices.find((device) => device.role === "gateway").name, "gateway.home.arpa");
  assert.equal(snapshot.scanCandidates[0], "192.168.44.0/30");
  assert.ok(snapshot.evidence.some((item) => item.type === "neighbor-cache"));
  assert.equal(snapshot.sources.find((item) => item.id === "local-network").status, "connected");
  assert.deepEqual(
    commands.filter(([command]) => command === "ping").map((command) => command.at(-1)),
    ["192.168.44.2"],
  );
});

test("[COL-01] passive collection never starts ICMP or other active probes", async () => {
  const commands = [];
  const runner = async (command, args) => {
    commands.push([command, ...args]);
    const signature = `${command} ${args.join(" ")}`;
    if (signature === "ip -json address show") return { stdout: JSON.stringify(ADDRESS_FIXTURE), stderr: "" };
    if (signature === "ip -json route show table main") return { stdout: JSON.stringify(ROUTE_FIXTURE), stderr: "" };
    if (signature === "ip -json neigh show") return { stdout: JSON.stringify(NEIGHBOR_FIXTURE), stderr: "" };
    throw Object.assign(new Error(`Unexpected command: ${signature}`), { code: "ENOENT" });
  };
  const snapshot = await collectLinux({
    profile: "passive",
    runner,
    textReader: async () => "",
    reverseLookup: async () => { throw new Error("reverse lookup must not run"); },
  });

  assert.equal(snapshot.profile, "passive");
  assert.equal(commands.some(([command]) => command === "ping"), false);
  assert.equal(snapshot.sources.find((item) => item.id === "icmp").status, "not-run");
});
