export function buildComparableServiceChanges(snapshots, currentSnapshot, protocol) {
  const field = protocol === "udp" ? "udpServices" : "tcpServices";
  const method = protocol === "udp" ? "udp-probe" : "tcp-connect";
  const currentIndex = snapshots.findIndex((snapshot) => snapshot.id === currentSnapshot?.id);
  const current = currentSnapshot?.[field];
  if (!current || currentIndex === -1) return emptyChanges();

  const previousSnapshot = snapshots.slice(0, currentIndex).reverse().find((snapshot) => {
    const candidate = snapshot[field];
    return candidate?.method === method
      && candidate.cidr === current.cidr
      && samePorts(candidate.ports, current.ports);
  });
  if (!previousSnapshot) return emptyChanges();

  const previous = previousSnapshot[field];
  const before = new Map((previous.endpoints ?? []).map((endpoint) => [endpointKey(endpoint, protocol), endpoint]));
  const after = new Map((current.endpoints ?? []).map((endpoint) => [endpointKey(endpoint, protocol), endpoint]));
  const added = [...after].filter(([key]) => !before.has(key)).map(([, endpoint]) => endpoint);
  const removed = [...before].filter(([key]) => !after.has(key)).map(([, endpoint]) => endpoint);
  return {
    comparable: true,
    previousSnapshotId: previousSnapshot.id,
    previousObservedAt: previousSnapshot.observedAt,
    added,
    removed,
    unchangedCount: [...after.keys()].filter((key) => before.has(key)).length,
  };
}

export function endpointKey(endpoint, protocol = endpoint.protocol) {
  return `${endpoint.address}:${endpoint.port}/${protocol}`;
}

function samePorts(left = [], right = []) {
  const first = [...new Set(left.map(Number))].sort((a, b) => a - b);
  const second = [...new Set(right.map(Number))].sort((a, b) => a - b);
  return first.length === second.length && first.every((port, index) => port === second[index]);
}

function emptyChanges() {
  return { comparable: false, previousSnapshotId: null, previousObservedAt: null, added: [], removed: [], unchangedCount: 0 };
}
