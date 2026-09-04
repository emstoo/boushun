const BASE_SOURCE_IDS = new Set([
  "local-network",
  "dns-config",
  "dhcp-leases",
  "kubernetes",
  "controller-exports",
  "oui-database",
]);

/**
 * Builds the current read model from append-only scan snapshots.
 *
 * A scan snapshot is an observation made by one workflow, not a replacement for
 * every other workflow. The newest passive facts form the base while source-owned
 * datasets (ICMP, discovery, SNMP, TCP and UDP) retain their latest observation.
 * No stored snapshot is mutated, so existing v1/v2 state files need no rewrite.
 */
export function composeCurrentSnapshot(snapshots = []) {
  const history = snapshots.filter(Boolean);
  const base = history.at(-1);
  if (!base) return null;

  const icmp = findLatest(history, (snapshot) => snapshot.scan?.method === "icmp-echo");
  const deep = findLatest(history, (snapshot) => snapshot.profile === "deep"
    || snapshot.sources?.some((source) => ["mdns", "ssdp", "snmpv3"].includes(source.id) && source.status !== "not-run"));
  const tcp = findLatest(history, (snapshot) => snapshot.tcpServices?.method === "tcp-connect");
  const udp = findLatest(history, (snapshot) => snapshot.udpServices?.method === "udp-probe");
  const selected = uniqueSnapshots([base, icmp, deep, tcp, udp]);

  const devices = mergeDevices(base.devices ?? [], [icmp, deep].filter(Boolean).flatMap((snapshot) => snapshot.devices ?? []));
  const discovery = {
    ...(base.discovery ?? {}),
    dhcp: base.discovery?.dhcp ?? [],
    mdns: deep?.discovery?.mdns ?? [],
    ssdp: deep?.discovery?.ssdp ?? [],
  };
  const sources = composeSources({ base, icmp, deep, tcp, udp });
  const evidence = uniqueById(selected.flatMap((snapshot) => snapshot.evidence ?? []));
  const explicitLinks = uniqueById([...(base.explicitLinks ?? []), ...(deep?.explicitLinks ?? [])]);
  const warnings = [...new Set(selected.flatMap((snapshot) => snapshot.warnings ?? []))];

  return {
    ...base,
    profile: "current",
    sourceProfile: base.profile,
    devices,
    discovery,
    scan: icmp?.scan ?? null,
    snmp: deep?.snmp ?? null,
    tcpServices: tcp?.tcpServices ?? null,
    udpServices: udp?.udpServices ?? null,
    evidence,
    explicitLinks,
    warnings,
    sources,
    summary: composeSummary(base.summary, icmp, tcp, udp),
    composition: {
      latestSnapshotId: base.id,
      sourceProfile: base.profile,
      sources: Object.fromEntries(Object.entries({
        base,
        icmp,
        discovery: deep,
        snmpv3: deep,
        "tcp-services": tcp,
        "udp-services": udp,
      }).filter(([, snapshot]) => snapshot).map(([id, snapshot]) => [id, {
        snapshotId: snapshot.id,
        observedAt: snapshot.observedAt,
      }])),
    },
  };
}

function composeSources(owners) {
  const result = new Map();
  addSources(result, owners.base, (id) => BASE_SOURCE_IDS.has(id));
  addSources(result, owners.icmp, (id) => id === "icmp");
  addSources(result, owners.deep, (id) => ["mdns", "ssdp", "snmpv3"].includes(id));
  addSources(result, owners.tcp, (id) => id === "tcp-services");
  addSources(result, owners.udp, (id) => id === "udp-services");
  return [...result.values()];
}

function addSources(target, snapshot, accepts) {
  for (const source of snapshot?.sources ?? []) {
    if (!accepts(source.id)) continue;
    target.set(source.id, { ...source, observedAt: snapshot.observedAt, snapshotId: snapshot.id });
  }
}

function composeSummary(summary, icmp, tcp, udp) {
  return {
    ...(summary ?? {}),
    ...(icmp?.scan ? { responsiveCount: icmp.scan.responsiveCount } : {}),
    ...(tcp?.tcpServices ? {
      tcpServiceCount: tcp.tcpServices.openCount,
      tcpServiceHostCount: tcp.tcpServices.openHostCount,
    } : {}),
    ...(udp?.udpServices ? {
      udpServiceCount: udp.udpServices.openCount,
      udpServiceHostCount: udp.udpServices.openHostCount,
      udpServiceUncertainCount: udp.udpServices.uncertainCount,
    } : {}),
  };
}

function mergeDevices(baseDevices, enrichmentDevices) {
  const devices = baseDevices.map(cloneDevice);
  for (const candidate of enrichmentDevices) {
    const current = findMatchingDevice(devices, candidate);
    if (!current) {
      devices.push(cloneDevice(candidate));
      continue;
    }
    current.addresses = unique([...(current.addresses ?? []), ...(candidate.addresses ?? [])]);
    current.evidenceIds = unique([...(current.evidenceIds ?? []), ...(candidate.evidenceIds ?? [])]);
    current.sourceKinds = unique([current.source, ...(current.sourceKinds ?? []), candidate.source, ...(candidate.sourceKinds ?? [])].filter(Boolean));
    for (const field of ["name", "manufacturer", "model", "os"]) current[field] ||= candidate[field] ?? null;
    if ((current.role ?? "host") === "host" && candidate.role && candidate.role !== "host") current.role = candidate.role;
    if (confidenceRank(candidate.identityConfidence) > confidenceRank(current.identityConfidence)) {
      current.identityConfidence = candidate.identityConfidence;
    }
  }
  return devices;
}

function findMatchingDevice(devices, candidate) {
  const addresses = new Set(candidate.addresses ?? []);
  return devices.find((device) => device.id === candidate.id)
    ?? (candidate.mac ? devices.find((device) => device.mac === candidate.mac) : null)
    ?? devices.find((device) => (device.addresses ?? []).some((address) => addresses.has(address)));
}

function cloneDevice(device) {
  return {
    ...device,
    addresses: [...(device.addresses ?? [])],
    evidenceIds: [...(device.evidenceIds ?? [])],
    sourceKinds: [...(device.sourceKinds ?? [])],
  };
}

function confidenceRank(value) {
  return ({ weak: 0, inferred: 1, strong: 2, verified: 3 })[value] ?? 0;
}

function findLatest(snapshots, predicate) {
  return [...snapshots].reverse().find(predicate) ?? null;
}

function uniqueSnapshots(snapshots) {
  return [...new Map(snapshots.filter(Boolean).map((snapshot) => [snapshot.id, snapshot])).values()];
}

function uniqueById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function unique(values) {
  return [...new Set(values)];
}
