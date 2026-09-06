const OCTET_MAX = 255;

export function parseIPv4(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const number = Number(part);
    return number <= OCTET_MAX ? number : Number.NaN;
  });

  if (octets.some(Number.isNaN)) return null;
  return octets;
}

export function ipv4ToInt(value) {
  const octets = Array.isArray(value) ? value : parseIPv4(value);
  if (!octets) return null;
  return (
    ((octets[0] << 24) >>> 0) +
    (octets[1] << 16) +
    (octets[2] << 8) +
    octets[3]
  ) >>> 0;
}

export function intToIPv4(value) {
  const number = Number(value) >>> 0;
  return [
    (number >>> 24) & 255,
    (number >>> 16) & 255,
    (number >>> 8) & 255,
    number & 255,
  ].join(".");
}

export function parseCIDR(value) {
  if (typeof value !== "string") return null;
  const [address, prefixText, ...rest] = value.trim().split("/");
  if (rest.length || prefixText === undefined || !/^\d{1,2}$/.test(prefixText)) {
    return null;
  }

  const prefix = Number(prefixText);
  const addressInt = ipv4ToInt(address);
  if (addressInt === null || prefix < 0 || prefix > 32) return null;

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = (addressInt & mask) >>> 0;
  const broadcastInt = (networkInt | (~mask >>> 0)) >>> 0;

  return {
    address,
    prefix,
    network: intToIPv4(networkInt),
    broadcast: intToIPv4(broadcastInt),
    first: intToIPv4(prefix >= 31 ? networkInt : networkInt + 1),
    last: intToIPv4(prefix >= 31 ? broadcastInt : broadcastInt - 1),
    size: 2 ** (32 - prefix),
    canonical: `${intToIPv4(networkInt)}/${prefix}`,
    networkInt,
    broadcastInt,
  };
}

export function containsIPv4(cidr, address) {
  const parsed = typeof cidr === "string" ? parseCIDR(cidr) : cidr;
  const addressInt = ipv4ToInt(address);
  return Boolean(
    parsed &&
      addressInt !== null &&
      addressInt >= parsed.networkInt &&
      addressInt <= parsed.broadcastInt,
  );
}

export function isAllowedLocalIPv4(address) {
  const value = ipv4ToInt(address);
  if (value === null) return false;

  return (
    containsIPv4("10.0.0.0/8", address) ||
    containsIPv4("172.16.0.0/12", address) ||
    containsIPv4("192.168.0.0/16", address) ||
    containsIPv4("169.254.0.0/16", address)
  );
}

export function assertSafeScanCIDR(value, allowedCIDRs = []) {
  const cidr = parseCIDR(value);
  if (!cidr) throw validationError("Enter a valid IPv4 CIDR");
  if (cidr.prefix < 24) {
    throw validationError("A scan cannot cover a range larger than /24 (256 addresses)");
  }
  if (!isAllowedLocalIPv4(cidr.network) || !isAllowedLocalIPv4(cidr.broadcast)) {
    throw validationError("Only private or link-local IPv4 ranges can be scanned");
  }

  if (!Array.isArray(allowedCIDRs) || !allowedCIDRs.length) {
    throw validationError("Set BOUSHUN_ALLOWED_CIDRS before starting an active scan");
  }
  const allowedRanges = allowedCIDRs.map(parseCIDR);
  if (allowedRanges.some((allowed) => !allowed)) {
    throw validationError("BOUSHUN_ALLOWED_CIDRS must contain valid IPv4 CIDRs");
  }
  const permitted = allowedRanges.some((allowed) =>
    cidr.networkInt >= allowed.networkInt && cidr.broadcastInt <= allowed.broadcastInt);
  if (!permitted) throw validationError("The requested range is outside BOUSHUN_ALLOWED_CIDRS");

  return cidr;
}

function validationError(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}

export function hostAddresses(cidrValue, exclusions = []) {
  const cidr = typeof cidrValue === "string" ? parseCIDR(cidrValue) : cidrValue;
  if (!cidr) throw new Error("Invalid CIDR");
  const excluded = new Set(exclusions);
  const start = cidr.prefix >= 31 ? cidr.networkInt : cidr.networkInt + 1;
  const end = cidr.prefix >= 31 ? cidr.broadcastInt : cidr.broadcastInt - 1;
  const result = [];
  for (let current = start; current <= end; current += 1) {
    const address = intToIPv4(current);
    if (!excluded.has(address)) result.push(address);
  }
  return result;
}
