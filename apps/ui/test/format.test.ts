import { describe, expect, it } from "vitest";
import type { PathStatus } from "@aceswarm/shared/api-types";
import {
  countryHint,
  formatFreshness,
  formatLoss,
  formatPeers,
  formatRtt,
  formatSpeed,
  formatStandbys,
  isFresh,
  pathLabel,
  peersHint,
  shownState,
  STATE_LABELS,
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

  it('counts the seconds instead of saying "Now" for a stream that is not playing', () => {
    // No new frames come: "Now", and its green, would say they do.
    expect(formatFreshness(ago(25), NOW, false)).toBe("25s ago");
    expect(formatFreshness(ago(59.9), NOW, false)).toBe("59s ago");
    expect(formatFreshness(ago(0), NOW, false)).toBe("1s ago");
    expect(isFresh(ago(25), NOW, false)).toBe(false);
    // From a minute on it reads the same either way.
    expect(formatFreshness(ago(60), NOW, false)).toBe("1m ago");
    expect(formatFreshness(ago(720), NOW, false)).toBe("12m ago");
    expect(formatFreshness(null, NOW, false)).toBe("Never");
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
    expect(formatPeers({ connected: 12, active: 4, uploading: null, countries: [] })).toBe("4 sending · 12 connected");
    expect(formatPeers({ connected: 12, active: null, uploading: null, countries: [] })).toBe("12 connected");
    expect(formatPeers({ connected: null, active: null, uploading: null, countries: [] })).toBe("Unknown");
  });

  it("says on a shared engine that the sending peers are the engine's, and puts the stream's own count first", () => {
    const peers = { connected: 8, active: 40, uploading: null, countries: [] };
    expect(formatPeers(peers, "playing", true)).toBe("8 connected · 40 sending on the shared engine");
    expect(formatPeers({ ...peers, connected: null }, "playing", true)).toBe("40 sending on the shared engine");
    expect(formatPeers({ ...peers, active: null }, "playing", true)).toBe("8 connected");
    expect(formatPeers({ ...peers, active: null, connected: null }, "playing", true)).toBe("Unknown");
    expect(formatPeers(peers, "playing", false)).toBe("40 sending · 8 connected");
    expect(formatPeers(peers, "stopped", true)).toBe("–");
  });

  it("explains what the figures count, and for a shared engine that the sending ones are shared", () => {
    expect(peersHint(false)).toContain("hot standby");
    expect(peersHint(false)).not.toContain("shared");
    expect(peersHint(true)).toContain("every stream on it");
    expect(countryHint("ES", 3, false)).toBe("Spain: 3 sending");
    expect(countryHint("ES", 3, true)).toBe("Spain: 3 sending on the shared engine");
  });

  it("shows none for a stopped stream, rather than peers nobody can know", () => {
    const none = { connected: null, active: null, uploading: null, countries: [] };
    expect(formatPeers(none, "stopped")).toBe("–");
    expect(formatPeers(none, "starting")).toBe("Unknown");
    expect(formatPeers({ ...none, connected: 3 }, "playing")).toBe("3 connected");
  });
});

describe("the state a stream shows", () => {
  it("is Disabled for a stream the user turned off, whatever state it still reports", () => {
    expect(shownState({ enabled: false, state: "playing" })).toBe("stopped");
    expect(shownState({ enabled: false, state: "stopped" })).toBe("stopped");
    expect(shownState({ enabled: true, state: "recovering" })).toBe("recovering");
    expect(STATE_LABELS[shownState({ enabled: false, state: "playing" })]).toBe("Disabled");
    expect(STATE_LABELS.playing).toBe("Live");
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
    // The gateway labels a tunnel with its profile's name, which is what a path it no longer reports gets.
    expect(pathLabel("wg:sweden", [])).toBe("sweden");
  });
});

describe("formatStandbys", () => {
  it("names each standby's path and whether it is hot", () => {
    const vpn = { id: "wg:mullvad-de", label: "mullvad-de" } as PathStatus;
    expect(formatStandbys([], [vpn])).toBe("–");
    expect(
      formatStandbys(
        [
          { path: "wg:mullvad-de", state: "hot", engine: { name: "e1", shared: false } },
          { path: "direct", state: "warming", engine: null },
        ],
        [vpn],
      ),
    ).toBe("mullvad-de (hot), Direct (warming up)");
  });
});
