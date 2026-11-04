/**
 * Parser and validator for wg-quick style WireGuard profiles (the `.conf` files VPN providers
 * hand out). Only the keys needed to bring a tunnel up are kept; wg-quick hooks such as `PostUp`
 * are rejected because the gateway never executes them.
 */

export interface WireguardInterface {
  privateKey: string;
  addresses: string[];
  dns: string[];
  mtu: number | undefined;
}

export interface WireguardPeer {
  publicKey: string;
  presharedKey: string | undefined;
  endpoint: string | undefined;
  allowedIps: string[];
  persistentKeepalive: number | undefined;
}

export interface WireguardConfig {
  iface: WireguardInterface;
  peers: WireguardPeer[];
}

export type ParseResult = { ok: true; config: WireguardConfig } | { ok: false; errors: string[] };

const KEY_PATTERN = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;
const IPV4_CIDR = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/(?:3[0-2]|[12]?\d))?$/;
const IPV6_CIDR = /^[0-9a-fA-F:]+(?:\/(?:12[0-8]|1[01]\d|\d?\d))?$/;
const FORBIDDEN_KEYS = new Set(["preup", "postup", "predown", "postdown", "saveconfig"]);
const IGNORED_INTERFACE_KEYS = new Set(["table", "listenport", "fwmark"]);
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isIpv4Cidr(value: string): boolean {
  return IPV4_CIDR.test(value);
}

function isCidr(value: string): boolean {
  return IPV4_CIDR.test(value) || (value.includes(":") && IPV6_CIDR.test(value));
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

interface RawSection {
  name: string;
  line: number;
  entries: { key: string; value: string; line: number }[];
}

function tokenize(text: string): { sections: RawSection[]; errors: string[] } {
  const sections: RawSection[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (line.length === 0) {
      continue;
    }
    const sectionMatch = /^\[(\w+)\]$/.exec(line);
    if (sectionMatch?.[1] !== undefined) {
      sections.push({ name: sectionMatch[1].toLowerCase(), line: lineNumber, entries: [] });
      continue;
    }
    const separator = line.indexOf("=");
    const current = sections.at(-1);
    if (separator <= 0 || current === undefined) {
      errors.push(`line ${String(lineNumber)}: expected "Key = Value" inside a section`);
      continue;
    }
    current.entries.push({
      key: line.slice(0, separator).trim().toLowerCase(),
      value: line.slice(separator + 1).trim(),
      line: lineNumber,
    });
  }
  return { sections, errors };
}

function parseInteger(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

function parseCidrList(value: string, where: string, label: string, errors: string[]): string[] {
  const valid: string[] = [];
  for (const entry of splitList(value)) {
    if (isCidr(entry)) {
      valid.push(entry);
    } else {
      errors.push(`${where}: invalid ${label} "${entry}"`);
    }
  }
  return valid;
}

function parseKey(value: string, where: string, label: string, errors: string[]): string | undefined {
  if (KEY_PATTERN.test(value)) {
    return value;
  }
  errors.push(`${where}: ${label} is not a valid WireGuard key`);
  return undefined;
}

function parseInterface(section: RawSection, errors: string[]): WireguardInterface | undefined {
  let privateKey: string | undefined;
  const addresses: string[] = [];
  const dns: string[] = [];
  let mtu: number | undefined;
  for (const { key, value, line } of section.entries) {
    const where = `line ${String(line)}`;
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${where}: "${key}" hooks are not supported`);
      continue;
    }
    switch (key) {
      case "privatekey": {
        privateKey = parseKey(value, where, "PrivateKey", errors);
        break;
      }
      case "address": {
        addresses.push(...parseCidrList(value, where, "Address", errors));
        break;
      }
      case "dns": {
        dns.push(...splitList(value));
        break;
      }
      case "mtu": {
        mtu = parseInteger(value, 1280, 9000);
        if (mtu === undefined) {
          errors.push(`${where}: MTU must be between 1280 and 9000`);
        }
        break;
      }
      default: {
        if (!IGNORED_INTERFACE_KEYS.has(key)) {
          errors.push(`${where}: unknown [Interface] key "${key}"`);
        }
      }
    }
  }
  if (privateKey === undefined) {
    errors.push("[Interface] is missing PrivateKey");
  }
  if (addresses.every((address) => !isIpv4Cidr(address))) {
    errors.push("[Interface] needs at least one IPv4 Address");
  }
  return privateKey === undefined ? undefined : { privateKey, addresses, dns, mtu };
}

function parsePeer(section: RawSection, errors: string[]): WireguardPeer | undefined {
  let publicKey: string | undefined;
  let presharedKey: string | undefined;
  let endpoint: string | undefined;
  const allowedIps: string[] = [];
  let persistentKeepalive: number | undefined;
  for (const { key, value, line } of section.entries) {
    const where = `line ${String(line)}`;
    switch (key) {
      case "publickey": {
        publicKey = parseKey(value, where, "PublicKey", errors);
        break;
      }
      case "presharedkey": {
        presharedKey = parseKey(value, where, "PresharedKey", errors);
        break;
      }
      case "endpoint": {
        if (/^[\w.-]+:\d{1,5}$|^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(value)) {
          endpoint = value;
        } else {
          errors.push(`${where}: Endpoint must look like host:port`);
        }
        break;
      }
      case "allowedips": {
        allowedIps.push(...parseCidrList(value, where, "AllowedIPs entry", errors));
        break;
      }
      case "persistentkeepalive": {
        persistentKeepalive = value === "off" ? undefined : parseInteger(value, 0, 65_535);
        break;
      }
      default: {
        errors.push(`${where}: unknown [Peer] key "${key}"`);
      }
    }
  }
  if (publicKey === undefined) {
    errors.push(`[Peer] at line ${String(section.line)} is missing PublicKey`);
    return undefined;
  }
  if (endpoint === undefined) {
    errors.push(`[Peer] at line ${String(section.line)} is missing Endpoint`);
  }
  return { publicKey, presharedKey, endpoint, allowedIps, persistentKeepalive };
}

export function parseWireguardConfig(text: string): ParseResult {
  const { sections, errors } = tokenize(text);
  const interfaces = sections.filter((section) => section.name === "interface");
  const peerSections = sections.filter((section) => section.name === "peer");
  for (const section of sections) {
    if (section.name !== "interface" && section.name !== "peer") {
      errors.push(`line ${String(section.line)}: unknown section [${section.name}]`);
    }
  }
  if (interfaces.length !== 1) {
    errors.push("the profile must contain exactly one [Interface] section");
  }
  if (peerSections.length === 0) {
    errors.push("the profile must contain at least one [Peer] section");
  }
  const iface = interfaces[0] === undefined ? undefined : parseInterface(interfaces[0], errors);
  const peers = peerSections
    .map((section) => parsePeer(section, errors))
    .filter((peer): peer is WireguardPeer => peer !== undefined);
  return errors.length > 0 || iface === undefined ? { ok: false, errors } : { ok: true, config: { iface, peers } };
}

/** Renders the subset accepted by `wg setconf` (no Address/DNS/MTU, which wg-quick handles). */
export function toSetconf(config: WireguardConfig): string {
  const lines = ["[Interface]", `PrivateKey = ${config.iface.privateKey}`];
  for (const peer of config.peers) {
    lines.push("", "[Peer]", `PublicKey = ${peer.publicKey}`);
    if (peer.presharedKey !== undefined) {
      lines.push(`PresharedKey = ${peer.presharedKey}`);
    }
    if (peer.endpoint !== undefined) {
      lines.push(`Endpoint = ${peer.endpoint}`);
    }
    lines.push(
      `AllowedIPs = ${peer.allowedIps.length > 0 ? peer.allowedIps.join(", ") : "0.0.0.0/0"}`,
      `PersistentKeepalive = ${String(peer.persistentKeepalive ?? 25)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface WireguardSummary {
  endpoint: string | null;
  addresses: string[];
}

/** Non-secret details that are safe to show in the UI. */
export function summarizeWireguard(config: WireguardConfig): WireguardSummary {
  return {
    endpoint: config.peers[0]?.endpoint ?? null,
    addresses: config.iface.addresses,
  };
}

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name);
}

/** Turns a free-form name (for example an uploaded file name) into a valid profile name. */
export function toProfileName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/\.conf$/, "")
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/^[-_]+|-+$/g, "")
    .slice(0, 32);
  return cleaned.length > 0 ? cleaned : "profile";
}
