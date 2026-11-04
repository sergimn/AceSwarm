/** Small IPv4 helpers (no dependency needed for subnet checks). */

export function ipToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }
    const octet = Number.parseInt(part, 10);
    if (octet > 255) {
      return undefined;
    }
    value = value * 256 + octet;
  }
  return value;
}

export function isIpv4(ip: string): boolean {
  return ipToInt(ip) !== undefined;
}

export function inSubnet(ip: string, cidr: string): boolean {
  const [network = "", bitsText = "32"] = cidr.split("/", 2);
  const address = ipToInt(ip);
  const base = ipToInt(network);
  const bits = Number.parseInt(bitsText, 10);
  if (address === undefined || base === undefined || Number.isNaN(bits)) {
    return false;
  }
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(base / size);
}

/** True for addresses that can never be a public peer (RFC 1918, loopback, CGNAT, link-local…). */
export function isPrivate(ip: string): boolean {
  return [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "224.0.0.0/4",
    "240.0.0.0/4",
  ].some((cidr) => inSubnet(ip, cidr));
}
