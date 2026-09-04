export function collectDemo(now = () => new Date(), options = {}) {
  const observedAt = now().toISOString();
  const e = (id, type, source, summary) => ({
    id: `evidence:demo:${id}`,
    type,
    source,
    observedAt,
    summary,
    raw: null,
  });

  const snapshot = {
    id: `demo-${observedAt}`,
    observedAt,
    profile: "demo",
    platform: "linux",
    hostname: "demo-probe",
    interfaces: [
      {
        index: 2,
        name: "eth0",
        mac: "02:00:00:00:00:50",
        state: "UP",
        mtu: 1500,
        addresses: [
          {
            address: "192.168.50.50",
            prefix: 24,
            cidr: "192.168.50.0/24",
            scope: "global",
            evidenceId: "evidence:demo:self",
          },
        ],
      },
    ],
    routes: [
      {
        destination: "default",
        gateway: "192.168.50.1",
        interface: "eth0",
        source: "192.168.50.50",
        metric: 100,
        protocol: "dhcp",
        evidenceId: "evidence:demo:route",
      },
    ],
    resolver: ["192.168.50.2", "192.168.50.3"],
    sources: [
      source("local-network", "Local network facts", 7, "Synthetic interface, route, and neighbor facts loaded"),
      source("dns-config", "DNS configuration", 2, "Two synthetic resolvers loaded"),
      source("icmp", "ICMP discovery", 7, "Seven synthetic devices responded"),
      source("snmpv3", "SNMPv3 topology", 4, "Synthetic LLDP and forwarding-table observations loaded"),
    ],
    devices: [
      device("device:self", "demo-probe", "192.168.50.50", "02:00:00:00:00:50", "scanner", "verified", "self"),
      device("device:router", "gateway.demo.test", "192.168.50.1", "02:00:00:00:00:01", "gateway", "strong", "router"),
      device("device:switch", "switch.demo.test", "192.168.50.10", "02:00:00:00:00:10", "switch", "strong", "switch"),
      device("device:ap", "access-point.demo.test", "192.168.50.20", "02:00:00:00:00:20", "access-point", "strong", "ap"),
      device("device:nas", "storage.demo.test", "192.168.50.30", "02:00:00:00:00:30", "server", "inferred", "nas"),
      device("device:camera", "camera.demo.test", "192.168.50.41", "02:00:00:00:00:41", "camera", "inferred", "camera"),
      device("device:laptop", "laptop.demo.test", "192.168.50.101", "02:00:00:00:01:01", "host", "weak", "laptop"),
    ],
    evidence: [
      e("self", "interface-address", "iproute2", "192.168.50.50/24 is configured on eth0"),
      e("route", "default-route", "iproute2", "The default gateway is 192.168.50.1"),
      e("router", "neighbor-cache", "iproute2", "192.168.50.1 was observed on eth0"),
      e("switch", "lldp-neighbor", "snmp", "LLDP evidence matches router lan1 to switch port 24"),
      e("ap", "lldp-neighbor", "snmp", "Switch port 8 announces access-point.demo.test"),
      e("nas", "forwarding-table", "snmp", "The NAS MAC is uniquely present on switch port 4"),
      e("camera", "forwarding-table", "snmp", "The camera MAC is uniquely present on switch port 6"),
      e("laptop", "neighbor-cache", "iproute2", "laptop.demo.test was observed in the neighbor cache"),
    ],
    explicitLinks: [
      link("router-switch", "device:router", "device:switch", "l2", "verified", "switch", "LAN1 ↔ port 24"),
      link("switch-ap", "device:switch", "device:ap", "l2", "strong", "ap", "port 8"),
      link("switch-nas", "device:switch", "device:nas", "l2", "inferred", "nas", "port 4"),
      link("switch-camera", "device:switch", "device:camera", "l2", "inferred", "camera", "port 6"),
    ],
    scan: { cidr: "192.168.50.0/24", targetCount: 253, responsiveCount: 7, method: "demo" },
    scanCandidates: ["192.168.50.0/24"],
    warnings: [],
    summary: { deviceCount: 7, neighborCount: 7, networkCount: 1, localAddressCount: 1 },
  };
  return options.includeServices ? withDemoServices(snapshot, observedAt) : snapshot;
}

function withDemoServices(snapshot, observedAt) {
  snapshot.sources.push(
    source("tcp-services", "TCP service discovery", 6, "Six synthetic TCP services loaded"),
    source("udp-services", "UDP service discovery", 2, "Two confirmed and one uncertain synthetic UDP observations loaded"),
  );
  snapshot.evidence.push(
    evidence(observedAt, "tcp-gateway-https", "tcp-service-open", "tcp-connect", "192.168.50.1:443/tcp accepted a connection"),
    evidence(observedAt, "tcp-ap-http", "tcp-service-open", "tcp-connect", "192.168.50.20:80/tcp accepted a connection"),
    evidence(observedAt, "tcp-storage-ssh", "tcp-service-open", "tcp-connect", "192.168.50.30:22/tcp accepted a connection"),
    evidence(observedAt, "tcp-storage-smb", "tcp-service-open", "tcp-connect", "192.168.50.30:445/tcp accepted a connection"),
    evidence(observedAt, "tcp-camera-rtsp", "tcp-service-open", "tcp-connect", "192.168.50.41:554/tcp accepted a connection"),
    evidence(observedAt, "tcp-probe-http", "tcp-service-open", "tcp-connect", "192.168.50.50:4177/tcp accepted a connection"),
    evidence(observedAt, "udp-gateway-dns", "udp-service-open", "udp-probe", "192.168.50.1:53/udp returned a datagram"),
    evidence(observedAt, "udp-camera-ssdp", "udp-service-open", "udp-probe", "192.168.50.41:1900/udp returned a datagram"),
    evidence(observedAt, "udp-summary", "udp-service-scan", "udp-probe", "Synthetic UDP coverage includes one open-or-filtered endpoint"),
  );
  snapshot.tcpServices = {
    cidr: "192.168.50.0/24",
    method: "tcp-connect",
    targetCount: 254,
    ports: [22, 80, 443, 445, 554, 4177],
    portCount: 6,
    attemptCount: 1_524,
    openCount: 6,
    openHostCount: 5,
    outcomeCounts: { open: 6, closed: 1_500, "filtered-or-unreachable": 18, unreachable: 0, error: 0 },
    endpoints: [
      endpoint("192.168.50.1", 443, "tcp", "https", "tcp-gateway-https", 1.8),
      endpoint("192.168.50.20", 80, "tcp", "http", "tcp-ap-http", 2.4),
      endpoint("192.168.50.30", 22, "tcp", "ssh", "tcp-storage-ssh", 1.2),
      endpoint("192.168.50.30", 445, "tcp", "smb", "tcp-storage-smb", 1.4),
      endpoint("192.168.50.41", 554, "tcp", "rtsp", "tcp-camera-rtsp", 3.1),
      endpoint("192.168.50.50", 4177, "tcp", "tcp-4177", "tcp-probe-http", 0.3),
    ],
  };
  snapshot.udpServices = {
    cidr: "192.168.50.0/24",
    method: "udp-probe",
    targetCount: 254,
    ports: [53, 123, 1900],
    portCount: 3,
    attemptCount: 762,
    transmissionCount: 1_520,
    openCount: 2,
    openHostCount: 2,
    uncertainCount: 1,
    outcomeCounts: { open: 2, closed: 8, "open-or-filtered": 752, unreachable: 0, error: 0 },
    endpoints: [
      { ...endpoint("192.168.50.1", 53, "udp", "dns", "udp-gateway-dns", 2.1), state: "open", serviceConfidence: "verified", responseBytes: 72, probesSent: 1 },
      { ...endpoint("192.168.50.41", 1900, "udp", "ssdp", "udp-camera-ssdp", 3.7), state: "open", serviceConfidence: "verified", responseBytes: 184, probesSent: 1 },
    ],
    uncertainEndpoints: [
      { ...endpoint("192.168.50.101", 123, "udp", "ntp", "udp-summary", null), state: "open-or-filtered", serviceConfidence: "inferred", probesSent: 2 },
    ],
  };
  Object.assign(snapshot.summary, { tcpServiceCount: 6, tcpServiceHostCount: 5, udpServiceCount: 2, udpServiceHostCount: 2, udpServiceUncertainCount: 1 });
  return snapshot;
}

function evidence(observedAt, id, type, sourceName, summary) {
  return { id: `evidence:demo:${id}`, type, source: sourceName, observedAt, summary, raw: null };
}

function source(id, label, recordCount, message) {
  return { id, label, configured: true, status: "connected", recordCount, message };
}

function endpoint(address, port, protocol, service, evidenceId, latencyMs) {
  return { address, port, protocol, service, latencyMs, evidenceIds: [`evidence:demo:${evidenceId}`] };
}

function device(id, name, address, mac, role, identityConfidence, evidenceId) {
  return {
    id,
    name,
    addresses: [address],
    mac,
    role,
    state: "REACHABLE",
    interface: "eth0",
    identityConfidence,
    evidenceIds: [`evidence:demo:${evidenceId}`],
    source: "demo",
  };
}

function link(id, source, target, layer, confidence, evidenceId, label) {
  return {
    id: `link:demo:${id}`,
    source,
    target,
    layer,
    relation: "physical-or-l2",
    confidence,
    label,
    evidenceIds: [`evidence:demo:${evidenceId}`],
  };
}
