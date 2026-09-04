import test from "node:test";
import assert from "node:assert/strict";
import { organizationForMac, parseOuiCsv } from "../src/enrichment/oui.js";

test("[COL-13, COL-14] IEEE CSV resolves globally administered MACs but not randomized MACs", () => {
  const database = parseOuiCsv('Registry,Assignment,Organization Name,Organization Address\nMA-L,001122,Example Corp,Tokyo\n');
  assert.equal(organizationForMac(database, "00:11:22:aa:bb:cc"), "Example Corp");
  assert.equal(organizationForMac(database, "02:11:22:aa:bb:cc"), null);
});
