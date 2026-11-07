import { describe, expect, it } from "vitest";
import type { PathStatus } from "@aceswarm/shared/api-types";
import {
  formatFreshness,
  formatLoss,
  formatPeers,
  formatRtt,
  formatSpeed,
  formatStandbys,
  isFresh,
  pathLabel,
  topCountries,
} from "../src/format.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

describe("formatFreshness", () => {
  it('says "Now" under a minute, then minutes, hours and days', () => {
    expect(formatFreshness(ago(0), NOW)).toBe("Now");
    expect(formatFreshness(ago(59), NOW)).toBe("Now");
    expect(formatFreshness(ago(60), NOW)).toBe("1m ago");
    expect(formatFreshness(ago(3599), NOW)).toBe("59m ago");
    expect(formatFreshness(ago(7200), NOW)).toBe("2h ago");
    expect(formatFreshness(ago(3 * 86_400), NOW)).toBe("3d ago");
  });

  it("handles missing and future timestamps", () => {
    expect(formatFreshness(null, NOW)).toBe("Never");
    expect(formatFreshness("garbage", NOW)).toBe("Never");
    expect(formatFreshness(ago(-30), NOW)).toBe("Now");
    expect(isFresh(ago(10), NOW)).toBe(true);
    expect(isFresh(ago(120), NOW)).toBe(false);
  });
});

describe("formatPeers", () => {
  it("leads with peers that send data", () => {
    expect(formatPeers({ connected: 12, active: 4, countries: [] })).toBe("4 sending · 12 connected");
    expect(formatPeers({ connected: 12, active: null, countries: [] })).toBe("12 connected");
    expect(formatPeers({ connected: null, active: null, countries: [] })).toBe("Unknown");
  });
});

describe("topCountries", () => {
  it("keeps the three biggest, ties alphabetically", () => {
    const countries = [
      { code: "US", count: 1 },
      { code: "ES", count: 5 },
      { code: "DE", count: 1 },
      { code: "FR", count: 3 },
    ];
    expect(topCountries(countries).map((country) => country.code)).toEqual(["ES", "FR", "DE"]);
    expect(countries[0]?.code).toBe("US");
  });
});

describe("small formatters", () => {
  it("formats speeds, latency and loss", () => {
    expect(formatSpeed(null)).toBe("–");
    expect(formatSpeed(512.4)).toBe("512 KB/s");
    expect(formatSpeed(1536)).toBe("1.5 MB/s");
    expect(formatRtt(12.6)).toBe("13 ms");
    expect(formatRtt(null)).toBe("–");
    expect(formatLoss(0.256)).toBe("26%");
  });

  it("labels paths", () => {
    expect(pathLabel(null, [])).toBe("–");
    expect(pathLabel("direct", [])).toBe("Direct");
    expect(pathLabel("wg:sweden", [])).toBe("VPN sweden");
  });
});

describe("formatStandbys", () => {
  it("names each standby's path and whether it is hot", () => {
    const vpn = { id: "wg:a", label: "VPN A" } as PathStatus;
    expect(formatStandbys([], [vpn])).toBe("–");
    expect(
      formatStandbys(
        [
          { path: "wg:a", state: "hot", engine: { name: "e1", shared: false } },
          { path: "direct", state: "warming", engine: null },
        ],
        [vpn],
      ),
    ).toBe("VPN A (hot), Direct (warming up)");
  });
});
