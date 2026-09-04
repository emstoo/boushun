import { readFile } from "node:fs/promises";

export async function loadOuiDatabase(filePath) {
  if (!filePath) return new Map();
  try {
    return parseOuiCsv(await readFile(filePath, "utf8"));
  } catch (error) {
    if (["ENOENT", "EACCES"].includes(error.code)) return new Map();
    throw error;
  }
}

export function parseOuiCsv(text) {
  const result = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const columns = csvColumns(line);
    if (columns.length < 3 || /^(registry|assignment)$/i.test(columns[0])) continue;
    const prefix = columns[1]?.replace(/[^0-9a-f]/gi, "").toUpperCase();
    const organization = columns[2]?.trim();
    if (prefix?.length >= 6 && organization) result.set(prefix.slice(0, 6), organization);
  }
  return result;
}

export function organizationForMac(database, mac) {
  const compact = String(mac ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (compact.length < 12 || (Number.parseInt(compact.slice(0, 2), 16) & 0x02) !== 0) return null;
  const prefix = compact.slice(0, 6);
  return prefix.length === 6 ? database.get(prefix) ?? null : null;
}

function csvColumns(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value); value = "";
    } else value += character;
  }
  values.push(value);
  return values;
}
