import { withInventory } from "./inventory.js";
import { isLocallyAdministeredMac, normalizeMac, normalizeMacInput } from "./mac.js";

const DEFAULT_MAXIMUM_SNAPSHOT_COUNT = 50;
const IDENTITY_FIELDS = ["name", "role", "manufacturer", "model", "os"];

export function buildMacTimelineIndex(snapshots = [], overrides = {}, settings = {}, options = {}) {
  const history = projectHistory(snapshots, overrides, settings);
  const items = [...history.macs].map((mac) => summarizeTimeline(buildTimelineFromHistory(history, mac))).sort(compareSummaries);
  return { retention: retention(history.snapshots, options.maximumSnapshotCount), items };
}

export function buildMacTimeline(snapshots = [], inputMac, overrides = {}, settings = {}, options = {}) {
  const mac = normalizeMacInput(inputMac);
  if (!mac) return null;
  const history = projectHistory(snapshots, overrides, settings);
  const timeline = buildTimelineFromHistory(history, mac);
  if (!timeline.entries.length) return null;
  return {
    mac,
    locallyAdministered: isLocallyAdministeredMac(mac),
    retention: retention(history.snapshots, options.maximumSnapshotCount),
    summary: summarizeTimeline(timeline),
    entries: timeline.entries,
  };
}

export function isValidMacTimelineInput(value) {
  return Boolean(normalizeMacInput(value));
}

function projectHistory(snapshots, overrides, settings) {
  const retained = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  const projected = retained.map((raw) => ({ raw, inventory: withInventory(raw, overrides, settings)?.inventory }));
  const macs = new Set(projected.flatMap(({ inventory }) => (inventory?.interfaces ?? []).map((item) => normalizeMac(item.mac)).filter(Boolean)));
  return { snapshots: retained, projected, macs };
}

function buildTimelineFromHistory(history, mac) {
  const entries = [];
  const previousBranches = new Map();
  for (const { raw, inventory } of history.projected) {
    if (!inventory) continue;
    const matchingInterfaces = inventory.interfaces.filter((item) => normalizeMac(item.mac) === mac);
    const deviceIds = unique(matchingInterfaces.map((item) => item.deviceId).filter(Boolean));
    if (!deviceIds.length) continue;
    const branches = deviceIds.map((deviceId) => branchAtPoint(inventory, deviceId, previousBranches.get(deviceId)))
      .filter(Boolean)
      .sort(compareBranches);
    if (!branches.length) continue;
    entries.push({
      snapshot: { id: raw.id, observedAt: raw.observedAt ?? null, profile: raw.profile ?? null },
      branches,
    });
    for (const branch of branches) previousBranches.set(branch.deviceId, { observedAt: raw.observedAt ?? null, branch });
  }
  return { mac, entries };
}

function branchAtPoint(inventory, deviceId, previous) {
  const device = inventory.devices.find((item) => item.id === deviceId);
  if (!device) return null;
  const assignments = inventory.ipAssignments.filter((item) => item.deviceId === deviceId);
  const responses = deduplicateResponses(assignments.flatMap((item) => item.observation?.responses ?? []));
  const branch = {
    deviceId,
    name: device.name ?? null,
    suggestedName: device.suggestedName ?? null,
    role: device.role ?? "host",
    manufacturer: device.manufacturer ?? null,
    model: device.model ?? null,
    os: device.os ?? null,
    identityConfidence: device.identityConfidence ?? "weak",
    needsIdentityReview: Boolean(device.needsIdentityReview),
    sourceKinds: unique(device.sourceKinds ?? []).sort(),
    tags: unique(device.tags ?? []).sort(),
    addresses: assignments.map((item) => item.address).filter(Boolean).sort(compareAddress),
    retrievedAt: device.observation?.retrievedAt ?? null,
    sourceObservedAt: device.observation?.sourceObservedAt ?? null,
    lastResponseAt: latestTime(responses.map((item) => item.respondedAt)),
    responses,
    changesSincePreviousObservation: null,
  };
  branch.changesSincePreviousObservation = changesSince(previous, branch);
  return branch;
}

function changesSince(previous, branch) {
  if (!previous) return null;
  const before = previous.branch;
  const beforeMethods = unique(before.responses.map((item) => item.method));
  const afterMethods = unique(branch.responses.map((item) => item.method));
  return {
    previousObservedAt: previous.observedAt,
    addressesAdded: branch.addresses.filter((item) => !before.addresses.includes(item)),
    addressesNoLongerRepresented: before.addresses.filter((item) => !branch.addresses.includes(item)),
    fieldsChanged: IDENTITY_FIELDS.filter((field) => (before[field] ?? null) !== (branch[field] ?? null)),
    responseMethodsAdded: afterMethods.filter((item) => !beforeMethods.includes(item)).sort(),
  };
}

function summarizeTimeline(timeline) {
  const allBranches = timeline.entries.flatMap((entry) => entry.branches.map((branch) => ({ entry, branch })));
  const newestFirst = [...allBranches].reverse();
  const preferred = newestFirst.find(({ branch }) => branch.name || branch.suggestedName || branch.addresses[0]);
  const manufacturer = newestFirst.find(({ branch }) => branch.manufacturer)?.branch.manufacturer ?? null;
  const retrievals = allBranches.map(({ branch }) => branch.retrievedAt);
  const responses = allBranches.map(({ branch }) => branch.lastResponseAt);
  return {
    mac: timeline.mac,
    preferredLabel: preferred ? preferred.branch.name || preferred.branch.suggestedName || preferred.branch.addresses[0] : timeline.mac,
    manufacturer,
    locallyAdministered: isLocallyAdministeredMac(timeline.mac),
    firstRetrievedAt: earliestTime(retrievals),
    lastRetrievedAt: latestTime(retrievals),
    lastResponseAt: latestTime(responses),
    observationPointCount: timeline.entries.length,
    branchCount: new Set(allBranches.map(({ branch }) => branch.deviceId)).size,
    needsIdentityReview: allBranches.some(({ branch }) => branch.needsIdentityReview)
      || timeline.entries.some((entry) => entry.branches.length > 1),
  };
}

function retention(snapshots, maximumSnapshotCount = DEFAULT_MAXIMUM_SNAPSHOT_COUNT) {
  const observed = snapshots.map((item) => item.observedAt).filter(validTime).sort();
  return {
    retainedSnapshotCount: snapshots.length,
    oldestRetainedAt: observed[0] ?? null,
    newestRetainedAt: observed.at(-1) ?? null,
    maximumSnapshotCount,
  };
}

function deduplicateResponses(responses) {
  const byKey = new Map();
  for (const response of responses) {
    const evidenceIds = unique(response.evidenceIds ?? []).sort();
    const item = {
      method: response.method,
      address: response.address,
      port: response.port ?? null,
      respondedAt: response.respondedAt ?? null,
      evidenceIds,
    };
    const key = [item.method, item.address, item.port ?? "", item.respondedAt ?? "", evidenceIds.join(",")].join(":");
    byKey.set(key, item);
  }
  return [...byKey.values()].sort((left, right) =>
    String(left.respondedAt ?? "").localeCompare(String(right.respondedAt ?? ""))
      || String(left.method).localeCompare(String(right.method))
      || compareAddress(left.address, right.address)
      || Number(left.port ?? 0) - Number(right.port ?? 0));
}

function compareSummaries(left, right) {
  return String(left.preferredLabel ?? "").localeCompare(String(right.preferredLabel ?? ""), undefined, { sensitivity: "base" })
    || left.mac.localeCompare(right.mac);
}

function compareBranches(left, right) {
  const leftLabel = left.name || left.suggestedName || left.addresses[0] || left.deviceId;
  const rightLabel = right.name || right.suggestedName || right.addresses[0] || right.deviceId;
  return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" }) || left.deviceId.localeCompare(right.deviceId);
}

function compareAddress(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

function earliestTime(values) {
  return values.filter(validTime).sort()[0] ?? null;
}

function latestTime(values) {
  return values.filter(validTime).sort().at(-1) ?? null;
}

function validTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function unique(values) {
  return [...new Set(values)];
}
