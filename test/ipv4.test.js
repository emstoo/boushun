import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeScanCIDR,
  containsIPv4,
  hostAddresses,
  parseCIDR,
  parseIPv4,
} from "../src/domain/ipv4.js";

test("[NET-01, NET-02] IPv4 and CIDR parsing returns canonical facts and rejects malformed input", () => {
  assert.deepEqual(parseIPv4("192.168.50.24"), [192, 168, 50, 24]);
  assert.equal(parseIPv4("192.168.50.999"), null);
  assert.equal(parseIPv4("not-an-ip"), null);
  for (const invalid of ["", "192.168.1.1", "192.168.1/24", "192.168.1.1/", "192.168.1.1/33", "192.168.1.1/24/extra"]) {
    assert.equal(parseCIDR(invalid), null, invalid);
  }

  const cidr = parseCIDR("192.168.50.50/24");
  assert.equal(cidr.canonical, "192.168.50.0/24");
  assert.equal(cidr.broadcast, "192.168.50.255");
  assert.equal(cidr.first, "192.168.50.1");
  assert.equal(cidr.last, "192.168.50.254");
  assert.equal(containsIPv4(cidr, "192.168.50.99"), true);
  assert.equal(containsIPv4(cidr, "192.168.12.1"), false);
});

test("[NET-03, NET-04, NET-05] scan safety rejects broad, non-local, and partially allowed ranges", () => {
  assert.equal(assertSafeScanCIDR("192.168.50.0/24", ["192.168.50.0/24"]).canonical, "192.168.50.0/24");
  assert.equal(assertSafeScanCIDR("169.254.1.0/24", ["169.254.1.0/24"]).canonical, "169.254.1.0/24");
  assert.equal(assertSafeScanCIDR("192.168.50.128/25", ["192.168.50.0/24"]).canonical, "192.168.50.128/25");
  assert.equal(assertSafeScanCIDR("192.168.50.0/24", ["192.168.50.0/24"]).canonical, "192.168.50.0/24");
  assert.throws(() => assertSafeScanCIDR("192.168.10.0/23"), /\/24/);
  assert.throws(() => assertSafeScanCIDR("8.8.8.0/24"), /private or link-local/);
  assert.throws(() => assertSafeScanCIDR("127.0.0.0/24"), /private or link-local/);
  assert.throws(
    () => assertSafeScanCIDR("192.168.50.0/24", ["192.168.20.0/24"]),
    /BOUSHUN_ALLOWED_CIDRS/,
  );
  assert.throws(
    () => assertSafeScanCIDR("192.168.50.0/24", ["192.168.50.0/25"]),
    /BOUSHUN_ALLOWED_CIDRS/,
  );
});

test("[NET-05] missing, empty, and malformed allowlists fail closed", () => {
  for (const allowed of [undefined, null, [], [""], [" "], ["invalid"], ["192.168.50.0/24", "invalid"], "192.168.50.0/24"]) {
    assert.throws(() => assertSafeScanCIDR("192.168.50.1/32", allowed), { code: "BAD_REQUEST" });
  }
});

test("[NET-06, NET-07, NET-08] host enumeration handles ordinary, /31, and /32 ranges", () => {
  assert.deepEqual(hostAddresses("192.168.50.0/30", ["192.168.50.1"]), ["192.168.50.2"]);
  assert.deepEqual(hostAddresses("192.168.50.0/31"), ["192.168.50.0", "192.168.50.1"]);
  assert.deepEqual(hostAddresses("192.168.50.7/32"), ["192.168.50.7"]);
});
