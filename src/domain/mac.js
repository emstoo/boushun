const CANONICAL_MAC = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const HYPHENATED_MAC = /^(?:[0-9a-f]{2}-){5}[0-9a-f]{2}$/;
const COMPACT_MAC = /^[0-9a-f]{12}$/;

/**
 * Normalizes collector input without narrowing the formats accepted before this
 * utility was shared. Invalid input returns null.
 */
export function normalizeMac(value) {
  if (typeof value !== "string") return null;
  const compact = value.toLowerCase().replace(/[^0-9a-f]/g, "");
  return compactMac(compact);
}

/**
 * Validates operator/API input. Only canonical, hyphenated, and compact forms
 * are accepted so arbitrary punctuation is not silently discarded.
 */
export function normalizeMacInput(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!CANONICAL_MAC.test(normalized) && !HYPHENATED_MAC.test(normalized) && !COMPACT_MAC.test(normalized)) return null;
  return compactMac(normalized.replaceAll(":", "").replaceAll("-", ""));
}

export function isLocallyAdministeredMac(value) {
  const mac = normalizeMac(value);
  return mac ? (Number.parseInt(mac.slice(0, 2), 16) & 2) !== 0 : false;
}

function compactMac(compact) {
  if (!COMPACT_MAC.test(compact)) return null;
  return compact.match(/.{2}/g).join(":");
}
