import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Imports read-only exports from controller-specific bridge scripts.
 * Schema: { devices: [], links: [], services: [] }. This keeps credentials and
 * vendor API churn outside Boushun while preserving source evidence here.
 */
export async function collectControllerSnapshots(paths, observedAt) {
  const devices = [];
  const links = [];
  const services = [];
  const evidence = [];
  const warnings = [];
  for (const filePath of paths ?? []) {
    try {
      const document = JSON.parse(await readFile(filePath, "utf8"));
      const normalized = normalizeControllerDocument(document, filePath, warnings);
      const digest = createHash("sha256").update(`${observedAt}\0${filePath}\0${JSON.stringify(normalized)}`).digest("hex").slice(0, 16);
      const record = { id: `evidence:${digest}`, type: "controller-export", source: filePath, observedAt, summary: `Read a controller topology export from ${filePath}`, raw: normalized };
      evidence.push(record);
      devices.push(...normalized.devices.map((item) => ({ ...item, evidenceIds: [...new Set([...(item.evidenceIds ?? []), record.id])] })));
      links.push(...normalized.links.map((item, index) => ({ ...item, id: item.id ?? `link:controller:${digest}:${index}`, evidenceIds: [...new Set([...(item.evidenceIds ?? []), record.id])] })));
      services.push(...normalized.services.map((item) => ({ ...item, evidenceIds: [...new Set([...(item.evidenceIds ?? []), record.id])] })));
    } catch (error) {
      warnings.push(`Controller export ${filePath}: ${String(error.code ?? error.message ?? error).slice(0, 160)}`);
    }
  }
  return { devices, links, services, evidence, warnings };
}

const DEVICE_FIELDS = ["id", "name", "mac", "addresses", "role", "manufacturer", "model", "state", "interface", "identityConfidence", "evidenceIds"];
const LINK_FIELDS = ["id", "source", "target", "layer", "relation", "confidence", "label", "evidenceIds"];
const SERVICE_FIELDS = ["id", "name", "namespace", "kind", "addresses", "clusterAddresses", "ports", "evidenceIds"];

function normalizeControllerDocument(input, filePath, warnings) {
  const document = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    devices: normalizeRecords(document.devices, DEVICE_FIELDS, "devices", filePath, warnings),
    links: normalizeRecords(document.links, LINK_FIELDS, "links", filePath, warnings),
    services: normalizeRecords(document.services, SERVICE_FIELDS, "services", filePath, warnings),
  };
}

function normalizeRecords(input, fields, label, filePath, warnings) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    warnings.push(`Controller export ${filePath}: ${label} must be an array`);
    return [];
  }
  return input.flatMap((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      warnings.push(`Controller export ${filePath}: ignored an invalid ${label} record`);
      return [];
    }
    return [Object.fromEntries(fields.flatMap((field) => Object.hasOwn(record, field) ? [[field, structuredClone(record[field])]] : []))];
  });
}
