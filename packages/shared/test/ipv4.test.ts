import { describe, expect, it } from "vitest";
import { inSubnet, ipToInt, isIpv4, isPrivate } from "../src/ipv4.ts";

describe("ipv4 helpers", () => {
  it("parses dotted quads strictly", () => {
    expect(ipToInt("0.0.0.0")).toBe(0);
    expect(ipToInt("255.255.255.255")).toBe(4_294_967_295);
    expect(isIpv4("256.1.1.1")).toBe(false);
    expect(isIpv4("1.2.3")).toBe(false);
    expect(isIpv4("1.2.3.x")).toBe(false);
  });

  it("checks subnets", () => {
    expect(inSubnet("172.31.250.130", "172.31.250.0/24")).toBe(true);
    expect(inSubnet("172.31.251.1", "172.31.250.0/24")).toBe(false);
    expect(inSubnet("10.1.2.3", "10.1.2.3")).toBe(true);
    expect(inSubnet("10.1.2.3", "0.0.0.0/0")).toBe(true);
    expect(inSubnet("nope", "10.0.0.0/8")).toBe(false);
  });

  it("never counts private, CGNAT, link-local or multicast addresses as peers", () => {
    for (const ip of [
      "10.0.0.1",
      "100.64.1.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.20.0.1",
      "192.168.1.1",
      "239.255.255.250",
    ]) {
      expect(isPrivate(ip)).toBe(true);
    }
    for (const ip of ["1.1.1.1", "198.51.100.10", "203.0.113.10"]) {
      expect(isPrivate(ip)).toBe(false);
    }
  });
});
