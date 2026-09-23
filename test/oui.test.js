import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadOuiDatabase, organizationForMac, parseOuiCsv } from "../src/enrichment/oui.js";

test("[COL-13, COL-14] IEEE CSV resolves globally administered MACs but not randomized MACs", () => {
  const database = parseOuiCsv('Registry,Assignment,Organization Name,Organization Address\nMA-L,001122,Example Corp,Tokyo\n');
  assert.equal(organizationForMac(database, "00:11:22:aa:bb:cc"), "Example Corp");
  assert.equal(organizationForMac(database, "02:11:22:aa:bb:cc"), null);
});

test("[DEP-07] OUI loader distinguishes connected, missing, unreadable, and invalid input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boushun-oui-loader-"));
  const validPath = path.join(directory, "oui.csv");
  const invalidPath = path.join(directory, "invalid.csv");
  await writeFile(validPath, "Registry,Assignment,Organization Name\nMA-L,001122,Example Corp\n");
  await writeFile(invalidPath, "<html>temporary error</html>\n");

  const connected = await loadOuiDatabase(validPath);
  assert.equal(connected.state, "connected");
  assert.equal(connected.records.size, 1);
  assert.equal((await loadOuiDatabase(path.join(directory, "missing.csv"))).state, "missing");
  assert.equal((await loadOuiDatabase(validPath, { reader: async () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  } })).state, "unreadable");
  assert.equal((await loadOuiDatabase(invalidPath)).state, "invalid");
});
