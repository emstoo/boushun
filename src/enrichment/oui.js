import { readFile } from "node:fs/promises";

export async function loadOuiDatabase(filePath, options = {}) {
  if (!filePath) return ouiLoadResult("missing");
  try {
    const text = options.reader
      ? await options.reader(filePath, "utf8")
      : await readFile(filePath, "utf8");
    const records = parseOuiCsv(text);
    return records.size > 0 ? ouiLoadResult("connected", records) : ouiLoadResult("invalid");
  } catch (error) {
    if (error?.code === "ENOENT") return ouiLoadResult("missing");
    if (["EACCES", "EPERM"].includes(error?.code)) return ouiLoadResult("unreadable");
    if (error?.code === "INVALID_OUI_CSV") return ouiLoadResult("invalid");
    throw error;
  }
}

export function parseOuiCsv(text) {
  const lines = String(text).split(/\r?\n/);
  const header = csvColumns(lines[0] ?? "");
  if (header[0]?.replace(/^\uFEFF/, "") !== "Registry"
    || header[1] !== "Assignment"
    || header[2] !== "Organization Name") {
    const error = new Error("Invalid IEEE MA-L CSV header");
    error.code = "INVALID_OUI_CSV";
    throw error;
  }
  const result = new Map();
  for (const line of lines.slice(1)) {
    const columns = csvColumns(line);
    if (columns.length < 3 || columns[0] !== "MA-L") continue;
    const prefix = columns[1]?.replace(/[^0-9a-f]/gi, "").toUpperCase();
    const organization = columns[2]?.trim();
    if (prefix?.length >= 6 && organization) result.set(prefix.slice(0, 6), organization);
  }
  return result;
}

function ouiLoadResult(state, records = new Map()) {
  return { state, records };
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
