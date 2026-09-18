export function orderedIdentityOperations(overrides = {}) {
  const merges = operationEntries("merge", overrides.merges, 0);
  const splits = operationEntries("split", overrides.splits, merges.length);
  const entries = [...merges, ...splits];
  const sequenced = entries
    .filter((entry) => validSequence(entry.operation.sequence))
    .sort((left, right) => left.operation.sequence - right.operation.sequence || left.ordinal - right.ordinal);
  const legacy = entries.filter((entry) => !validSequence(entry.operation.sequence));
  const pendingByKey = new Map();
  const applied = new Set();
  const orderedLegacy = [];

  for (const entry of legacy) {
    const key = operationKey(entry.kind, entry.operation.id);
    if (!key) continue;
    const pending = pendingByKey.get(key) ?? [];
    pending.push(entry);
    pendingByKey.set(key, pending);
  }

  const applyLegacy = (kind, id) => {
    const pending = pendingByKey.get(operationKey(kind, id)) ?? [];
    const entry = pending.find((candidate) => !applied.has(candidate));
    if (!entry) return;
    applied.add(entry);
    orderedLegacy.push(entry);
  };

  for (const audit of Array.isArray(overrides.audit) ? overrides.audit : []) {
    if (audit?.action === "device.merge") {
      applyLegacy("merge", audit.details?.id);
    } else if (audit?.action === "device.split") {
      applyLegacy("split", audit.details?.id);
    } else if (audit?.action === "device.recommended-split") {
      for (const split of audit.details?.splits ?? []) applyLegacy("split", split?.id);
    }
  }

  // Legacy files without matching audit entries used split-before-merge ordering.
  for (const entry of [...splits, ...merges]) {
    if (!validSequence(entry.operation.sequence) && !applied.has(entry)) orderedLegacy.push(entry);
  }

  // Unsequenced operations predate operations written with persistent ordering.
  return [...orderedLegacy, ...sequenced];
}

function operationEntries(kind, operations, offset) {
  return (Array.isArray(operations) ? operations : []).flatMap((operation, index) =>
    operation && typeof operation === "object" && !Array.isArray(operation)
      ? [{ kind, operation, ordinal: offset + index }]
      : []);
}

function operationKey(kind, id) {
  return typeof id === "string" && id ? `${kind}:${id}` : null;
}

function validSequence(value) {
  return Number.isSafeInteger(value) && value > 0;
}
