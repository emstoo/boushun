import { containsIPv4 } from "./ipv4.js";

// Checks retain their own coverage and clock. Reading a cache is never a check.
export function observationChecks(snapshot) {
  if (!snapshot) return [];
  if (snapshot.observationChecks) return snapshot.observationChecks;
  const checks = [];
  const add = (method, result, responses, extra = {}) => {
    if (!result) return;
    checks.push({ method, cidr: result.cidr ?? null, ports: result.ports ?? [], snapshotId: snapshot.id,
      retrievedAt: snapshot.retrievedAt ?? snapshot.observedAt, ...extra,
      responses: responses.map((item) => ({ ...item, method, snapshotId: snapshot.id })) });
  };
  if (snapshot.scan?.probes) {
    add("icmp-echo", snapshot.scan, snapshot.scan.probes.filter((probe) => probe.result === "response").map((probe) => ({
      address: probe.address, respondedAt: probe.observedAt ?? evidenceTime(snapshot, [probe.evidenceId]),
      evidenceIds: [probe.evidenceId].filter(Boolean),
    })), { addresses: snapshot.scan.probes.map((probe) => probe.address) });
  }
  for (const [key, method] of [["tcpServices", "tcp-connect"], ["udpServices", "udp-probe"]]) {
    const result = snapshot[key];
    if (!result || result.outcomeCounts?.error) continue;
    add(method, result, (result.endpoints ?? []).filter((item) => !item.state || item.state === "open").map((item) => ({
      address: item.address, port: item.port, respondedAt: item.observedAt ?? evidenceTime(snapshot, item.evidenceIds),
      evidenceIds: item.evidenceIds ?? [],
    })));
  }
  for (const observation of snapshot.snmp?.observations ?? []) {
    add("snmpv3", {}, [{ address: observation.target, respondedAt: observation.observedAt ?? evidenceTime(snapshot, observation.evidenceIds),
      evidenceIds: observation.evidenceIds ?? [] }], { addresses: [observation.target] });
  }
  for (const method of ["mdns", "ssdp"]) {
    const records = snapshot.discovery?.[method] ?? [];
    const responses = records.filter((record) => record.responderAddress).map((record) => ({ address: record.responderAddress,
      respondedAt: record.observedAt ?? null, evidenceIds: record.evidenceIds ?? [] }));
    if (responses.length) add(method, {}, responses, { addresses: responses.map((item) => item.address) });
  }
  return checks;
}

export function currentResponses(checks) {
  const responses = new Map();
  for (const check of checks) {
    // A later check supersedes only the addresses and ports it actually covered.
    for (const [key, previous] of responses) {
      if (previous.method !== check.method) continue;
      const coveredAddress = check.addresses ? check.addresses.includes(previous.address)
        : check.cidr && containsIPv4(check.cidr, previous.address);
      if (coveredAddress && (!previous.port || check.ports.includes(previous.port))) responses.delete(key);
    }
    for (const response of check.responses) responses.set(`${response.method}:${response.address}:${response.port ?? ""}`, response);
  }
  return [...responses.values()];
}

export function annotateObservations(snapshot, { devices, assignments, services }) {
  const responses = currentResponses(observationChecks(snapshot));
  const rawDevices = new Map((snapshot.devices ?? []).map((device) => [device.id, device]));
  for (const assignment of assignments.values()) {
    const device = devices.get(assignment.deviceId);
    const local = device?.id === "device:self";
    const registered = (snapshot.kubernetes?.nodes ?? []).some((node) => node.addresses?.includes(assignment.address))
      || (snapshot.kubernetes?.services ?? []).some((service) => service.addresses?.includes(assignment.address));
    assignment.observation = assessment(local ? "local" : registered ? "registered" : "candidate",
      responses.filter((response) => response.address === assignment.address), snapshot, rawDevices.get(device?.id));
  }
  for (const device of devices.values()) {
    const owned = [...assignments.values()].filter((item) => item.deviceId === device.id);
    const registered = device.sourceKinds.includes("kubernetes-api");
    device.observation = assessment(device.id === "device:self" ? "local" : registered ? "registered" : "candidate",
      owned.flatMap((assignment) => assignment.observation.responses), snapshot, rawDevices.get(device.id));
    device.status = { local: "configured", registered: "registered", response: "responded", candidate: "unconfirmed" }[device.observation.kind];
  }
  for (const service of services.values()) {
    const method = service.kind === "tcp-service" ? "tcp-connect" : service.kind === "udp-service" ? "udp-probe" : null;
    service.observation = assessment(service.kind.startsWith("kubernetes-") ? "registered" : "candidate",
      responses.filter((response) => response.method === method && service.addresses.includes(response.address)
        && service.ports.some((port) => port.port === response.port)), snapshot);
  }
}

function assessment(kind, responses, snapshot, raw) {
  const evidence = (snapshot.evidence ?? []).filter((item) => raw?.evidenceIds?.includes(item.id));
  const lastResponseAt = latestTime(responses.map((response) => response.respondedAt));
  return {
    kind: kind === "local" ? kind : responses.length ? "response" : kind,
    retrievedAt: raw?.retrievedAt ?? snapshot.retrievedAt ?? snapshot.observedAt ?? null,
    sourceObservedAt: latestTime(evidence.map((item) => item.sourceObservedAt)),
    lastResponseAt, responses,
  };
}

function evidenceTime(snapshot, ids = []) {
  return latestTime((snapshot.evidence ?? []).filter((item) => ids?.includes(item.id)).map((item) => item.sourceObservedAt ?? item.observedAt ?? item.raw?.observedAt));
}

export function latestTime(values) {
  return values.filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value))).sort().at(-1) ?? null;
}
