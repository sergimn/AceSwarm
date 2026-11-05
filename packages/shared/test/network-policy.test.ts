import { describe, expect, it } from "vitest";
import { isPathAllowed, parseNetworkPolicy, serializeNetworkPolicy } from "../src/network-policy.ts";

describe("parseNetworkPolicy", () => {
  it("defaults to allowing the direct path when there is no file", () => {
    expect(parseNetworkPolicy(undefined)).toEqual({ policy: { wireguardOnly: false }, error: null });
  });

  it("reads back what was written", () => {
    for (const wireguardOnly of [true, false]) {
      const text = JSON.stringify(serializeNetworkPolicy({ wireguardOnly }));
      expect(parseNetworkPolicy(text)).toEqual({ policy: { wireguardOnly }, error: null });
    }
  });

  it("fails closed on files it does not understand", () => {
    for (const text of ["", "not json", "{}", '{"version": 2, "wireguardOnly": false}', '{"wireguardOnly": "no"}']) {
      const result = parseNetworkPolicy(text);
      expect(result.policy.wireguardOnly, text).toBe(true);
      expect(result.error, text).not.toBeNull();
    }
  });
});

describe("isPathAllowed", () => {
  it("only keeps engines off the direct path while WireGuard only is on", () => {
    expect(isPathAllowed({ wireguardOnly: false }, "direct")).toBe(true);
    expect(isPathAllowed({ wireguardOnly: true }, "direct")).toBe(false);
    expect(isPathAllowed({ wireguardOnly: true }, "wg:mullvad")).toBe(true);
  });
});
