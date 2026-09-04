import dgram from "node:dgram";
import { createHash } from "node:crypto";

export async function collectDiscovery(options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const timeout = Math.max(250, Math.min(options.timeout ?? 1_800, 5_000));
  const ssdpCollector = options.discoverSsdp ?? discoverSsdp;
  const mdnsCollector = options.discoverMdns ?? discoverMdns;
  const results = await Promise.allSettled([
    ssdpCollector({ timeout, signal: options.signal }),
    mdnsCollector({ timeout, signal: options.signal }),
  ]);
  const warnings = [];
  const evidence = [];
  const ssdp = normalizeSettled(results[0], "SSDP", warnings).map((item) => evidenceRecord(item, "ssdp", observedAt, evidence));
  const mdns = normalizeSettled(results[1], "mDNS", warnings).map((item) => evidenceRecord(item, "mdns", observedAt, evidence));
  return { ssdp, mdns, evidence, warnings };
}

export function discoverSsdp({ timeout = 1_800, signal, createSocket } = {}) {
  const query = Buffer.from([
    "M-SEARCH * HTTP/1.1",
    "HOST: 239.255.255.250:1900",
    'MAN: "ssdp:discover"',
    "MX: 1",
    "ST: ssdp:all",
    "",
    "",
  ].join("\r\n"));
  return udpCollect({ family: "udp4", port: 1900, host: "239.255.255.250", query, timeout, signal, createSocket }, (message, remote) => {
    const text = message.toString("utf8");
    if (!/^HTTP\/1\.[01] 200\b/i.test(text)) throw new Error("Invalid SSDP response");
    const headers = parseHttpHeaders(text);
    return {
      address: remote.address,
      name: headers.server ?? null,
      model: headers.st ?? null,
      location: headers.location ?? null,
      usn: headers.usn ?? null,
      source: "ssdp",
    };
  });
}

export function discoverMdns({ timeout = 1_800, signal, createSocket } = {}) {
  const query = dnsPtrQuery("_services._dns-sd._udp.local");
  return udpCollect({ family: "udp4", port: 5353, host: "224.0.0.251", query, timeout, signal, createSocket }, (message, remote) => {
    if (message.length < 12 || (message[2] & 0x80) === 0) throw new Error("Invalid mDNS response");
    const names = parseDnsNames(message);
    return {
      address: remote.address,
      hostname: names.find((name) => name.endsWith(".local")) ?? null,
      services: names.filter((name) => name.startsWith("_")).slice(0, 20),
      source: "mdns",
    };
  });
}

function udpCollect(input, parser) {
  return new Promise((resolve) => {
    if (input.signal?.aborted) return resolve([]);
    const socket = input.createSocket ? input.createSocket(input.family) : dgram.createSocket(input.family);
    const results = new Map();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", finish);
      socket.close();
      resolve([...results.values()]);
    };
    const timer = setTimeout(finish, input.timeout);
    input.signal?.addEventListener("abort", finish, { once: true });
    socket.on("message", (message, remote) => {
      try {
        const item = parser(message, remote);
        results.set(`${remote.address}:${JSON.stringify(item)}`, item);
      } catch {
        // Malformed multicast responses are ignored.
      }
    });
    socket.on("error", finish);
    socket.bind(0, () => socket.send(input.query, input.port, input.host, (error) => { if (error) finish(); }));
  });
}

function dnsPtrQuery(name) {
  const labels = name.split(".").flatMap((label) => [Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)]);
  return Buffer.concat([
    Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...labels,
    Buffer.from([0, 0, 12, 0, 1]),
  ]);
}

function parseDnsNames(buffer) {
  const result = new Set();
  for (let offset = 12; offset < buffer.length;) {
    const parsed = readDnsName(buffer, offset, new Set());
    if (parsed.name.includes(".")) result.add(parsed.name.replace(/\.$/, ""));
    offset = parsed.next > offset ? parsed.next : offset + 1;
    if (offset + 4 <= buffer.length) offset += 4;
  }
  return [...result];
}

function readDnsName(buffer, start, visited) {
  const labels = [];
  let offset = start;
  let next = start;
  while (offset < buffer.length) {
    const length = buffer[offset];
    if (length === 0) { next = Math.max(next, offset + 1); break; }
    if ((length & 0xc0) === 0xc0 && offset + 1 < buffer.length) {
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      next = Math.max(next, offset + 2);
      if (visited.has(pointer)) break;
      visited.add(pointer);
      labels.push(...readDnsName(buffer, pointer, visited).name.split(".").filter(Boolean));
      break;
    }
    if (length > 63 || offset + 1 + length > buffer.length) break;
    labels.push(buffer.subarray(offset + 1, offset + 1 + length).toString("utf8"));
    offset += length + 1;
    next = Math.max(next, offset);
  }
  return { name: labels.join("."), next };
}

function parseHttpHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function evidenceRecord(item, type, observedAt, evidence) {
  const summary = `${item.address} responded over ${type.toUpperCase()}`;
  const digest = createHash("sha256").update(`${observedAt}\0${type}\0${JSON.stringify(item)}`).digest("hex").slice(0, 16);
  const record = { id: `evidence:${digest}`, type: `${type}-announcement`, source: type, observedAt, summary, raw: item };
  evidence.push(record);
  return { ...item, evidenceIds: [record.id] };
}

function normalizeSettled(result, label, warnings) {
  if (result.status === "fulfilled") return result.value;
  warnings.push(`${label} discovery failed: ${String(result.reason?.message ?? result.reason).slice(0, 160)}`);
  return [];
}
