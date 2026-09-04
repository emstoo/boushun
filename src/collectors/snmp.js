import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import snmp from "net-snmp";

const OIDS = {
  system: "1.3.6.1.2.1.1",
  interfaces: "1.3.6.1.2.1.31.1.1.1",
  bridgePorts: "1.3.6.1.2.1.17.1.4.1",
  fdb: "1.3.6.1.2.1.17.4.3.1",
  lldpRemote: "1.0.8802.1.1.2.1.4.1.1",
};

export async function readSnmpTargets(filePath) {
  if (!filePath) return [];
  try {
    const document = JSON.parse(await readFile(filePath, "utf8"));
    return (Array.isArray(document) ? document : document.targets ?? []).map(validateTarget);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function collectSnmp(options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const createSession = options.createSession ?? createV3Session;
  const targets = options.targets ?? [];
  const evidence = [];
  const warnings = [];
  const observations = [];

  for (let index = 0; index < targets.length; index += 1) {
    if (options.signal?.aborted) throw abortError();
    const target = validateTarget(targets[index]);
    options.onProgress?.({ phase: "snmp", completed: index, total: targets.length, message: `SNMP ${target.host}` });
    let session;
    try {
      session = createSession(target);
      const [system, interfaces, bridgePorts, fdb, lldpRemote] = await Promise.all([
        walk(session, OIDS.system, options.signal),
        walk(session, OIDS.interfaces, options.signal),
        walk(session, OIDS.bridgePorts, options.signal),
        walk(session, OIDS.fdb, options.signal),
        walk(session, OIDS.lldpRemote, options.signal),
      ]);
      const normalized = normalizeObservation(target, { system, interfaces, bridgePorts, fdb, lldpRemote });
      const record = makeEvidence(observedAt, target.host, normalized);
      evidence.push(record);
      normalized.evidenceIds = [record.id];
      observations.push(normalized);
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      warnings.push(`SNMP ${target.host}: ${safeMessage(error, target)}`);
    } finally {
      session?.close();
    }
  }
  options.onProgress?.({ phase: "snmp", completed: targets.length, total: targets.length, message: "SNMP collection complete" });
  return { observations, evidence, warnings };
}

export function normalizeObservation(target, tables) {
  const values = Object.fromEntries(tables.system.map((item) => [item.oid, valueText(item.value)]));
  const interfaceRows = rowsFromColumns(tables.interfaces, OIDS.interfaces);
  const bridgeRows = rowsFromColumns(tables.bridgePorts, OIDS.bridgePorts);
  const fdbRows = rowsFromColumns(tables.fdb, OIDS.fdb);
  const lldpRows = rowsFromColumns(tables.lldpRemote, OIDS.lldpRemote, 3);
  const bridgeToIfIndex = Object.fromEntries(Object.entries(bridgeRows).map(([index, row]) => [index, numberValue(row[2])]));

  return {
    target: target.host,
    name: values[`${OIDS.system}.5.0`] ?? null,
    description: values[`${OIDS.system}.1.0`] ?? null,
    location: values[`${OIDS.system}.6.0`] ?? null,
    interfaces: Object.entries(interfaceRows).map(([index, row]) => ({
      index: Number(index),
      name: valueText(row[1]) || null,
      mac: bufferMac(row[6]),
      alias: valueText(row[18]) || null,
    })),
    fdb: Object.entries(fdbRows).map(([index, row]) => ({
      mac: bufferMac(row[1]) || dottedIndexMac(index),
      bridgePort: numberValue(row[2]),
      interfaceIndex: bridgeToIfIndex[numberValue(row[2])] ?? null,
      status: numberValue(row[3]),
    })).filter((row) => row.mac),
    lldp: Object.entries(lldpRows).map(([index, row]) => ({
      index,
      chassisSubtype: numberValue(row[4]),
      chassisId: bufferMac(row[5]) || valueText(row[5]),
      portSubtype: numberValue(row[6]),
      portId: valueText(row[7]),
      portDescription: valueText(row[8]),
      systemName: valueText(row[9]),
      systemDescription: valueText(row[10]),
    })),
  };
}

function createV3Session(target) {
  const levels = snmp.SecurityLevel;
  const authProtocols = snmp.AuthProtocols;
  const privProtocols = snmp.PrivProtocols;
  const level = levels[target.level ?? "authPriv"];
  if (level === undefined) throw new Error(`Unsupported SNMPv3 level: ${target.level}`);
  const user = { name: target.user, level };
  if (target.level !== "noAuthNoPriv") {
    user.authProtocol = authProtocols[target.authProtocol ?? "sha256"];
    user.authKey = target.authKey;
  }
  if ((target.level ?? "authPriv") === "authPriv") {
    user.privProtocol = privProtocols[target.privProtocol ?? "aes"];
    user.privKey = target.privKey;
  }
  return snmp.createV3Session(target.host, user, {
    port: target.port ?? 161,
    retries: target.retries ?? 1,
    timeout: target.timeout ?? 2_500,
    transport: target.transport ?? "udp4",
    context: target.context ?? "",
  });
}

function walk(session, oid, signal) {
  return new Promise((resolve, reject) => {
    const records = [];
    const abort = () => reject(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    session.subtree(oid, 20, (varbinds) => {
      for (const item of varbinds) if (!snmp.isVarbindError(item)) records.push({ oid: item.oid, value: item.value });
      return signal?.aborted === true;
    }, (error) => {
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(records);
    });
  });
}

function rowsFromColumns(records, base, indexParts = 1) {
  const rows = {};
  for (const item of records) {
    const suffix = item.oid.slice(base.length + 1).split(".");
    const column = suffix.shift();
    const index = suffix.slice(-Math.max(indexParts, suffix.length)).join(".");
    rows[index] ||= {};
    rows[index][column] = item.value;
  }
  return rows;
}

function validateTarget(input) {
  if (!input || typeof input.host !== "string" || typeof input.user !== "string") throw new Error("An SNMP target requires host and user");
  const level = input.level ?? "authPriv";
  if (level !== "noAuthNoPriv" && !input.authKey) throw new Error(`SNMP ${input.host}: authKey is required`);
  if (level === "authPriv" && !input.privKey) throw new Error(`SNMP ${input.host}: privKey is required`);
  return { ...input, level };
}

function makeEvidence(observedAt, host, observation) {
  const raw = { ...observation };
  const digest = createHash("sha256").update(`${observedAt}\0${host}\0${JSON.stringify(raw)}`).digest("hex").slice(0, 16);
  return {
    id: `evidence:${digest}`,
    type: "snmp-topology",
    source: "snmpv3",
    observedAt,
    summary: `Read IF-MIB, LLDP-MIB, and BRIDGE-MIB from ${host}`,
    raw,
  };
}

function valueText(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8").replace(/\0+$/, "");
  return value === undefined || value === null ? "" : String(value);
}

function numberValue(value) {
  const number = Number(valueText(value));
  return Number.isFinite(number) ? number : null;
}

function bufferMac(value) {
  if (!Buffer.isBuffer(value) || value.length !== 6) return null;
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}

function dottedIndexMac(index) {
  const bytes = String(index).split(".").slice(-6).map(Number);
  return bytes.length === 6 && bytes.every((byte) => byte >= 0 && byte <= 255)
    ? bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(":")
    : null;
}

function abortError() {
  const error = new Error("Scan cancelled");
  error.name = "AbortError";
  return error;
}

function safeMessage(error, target) {
  let message = String(error?.message ?? error);
  for (const value of [target?.authKey, target?.privKey].filter((item) => typeof item === "string" && item)) {
    message = message.replaceAll(value, "[redacted]");
  }
  return message
    .replace(/(["']?)(authKey|privKey)\1\s*[:=]\s*(["'])[^"']*\3/gi, "$2=[redacted]")
    .replace(/(authKey|privKey)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240);
}
