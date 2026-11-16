import { describe, expect, it } from "vitest";
import { formatFreshness } from "../src/format.ts";
import { connectionLabel, PageClock, STALE_AFTER_MS, staleNotice } from "../src/liveness.ts";

const SERVER_NOW = Date.parse("2026-11-16T12:00:00Z");
const generatedAt = new Date(SERVER_NOW).toISOString();
const frameAt = (secondsAgo: number): string => new Date(SERVER_NOW - secondsAgo * 1000).toISOString();

describe("PageClock", () => {
  it("tells the controller's time from the snapshot and the time since it arrived", () => {
    const clock = new PageClock();
    clock.receive(generatedAt, 10_000);
    expect(clock.read(10_000)).toEqual({ now: SERVER_NOW, stale: false, silentMs: 0 });
    expect(clock.read(13_500)).toEqual({ now: SERVER_NOW + 3500, stale: false, silentMs: 3500 });
  });

  it("ignores the browser's clock, however wrong it is", () => {
    // A frame 1 s old by the controller's clock, and a browser clock 5 minutes fast or slow:
    // Date.now() is never read once a snapshot arrived.
    for (const skew of [5 * 60_000, -5 * 60_000, 3 * 3_600_000]) {
      const clock = new PageClock();
      clock.receive(generatedAt, 0);
      const real = Date.now;
      Date.now = () => real() + skew;
      try {
        expect(formatFreshness(frameAt(1), clock.read(0).now)).toBe("Now");
        expect(formatFreshness(frameAt(300), clock.read(0).now)).toBe("5m ago");
        expect(formatFreshness(frameAt(40), clock.read(0).now, false)).toBe("40s ago");
      } finally {
        Date.now = real;
      }
    }
  });

  it("keeps counting between snapshots, so a figure that stops being renewed gets older", () => {
    const clock = new PageClock();
    clock.receive(generatedAt, 0);
    // The last frame was 1 s old when the snapshot was made; 70 s later nothing newer is known.
    expect(formatFreshness(frameAt(1), clock.read(0).now)).toBe("Now");
    expect(formatFreshness(frameAt(1), clock.read(70_000).now)).toBe("1m ago");
  });

  it("is stale only after more than three missed snapshots", () => {
    const clock = new PageClock();
    clock.receive(generatedAt, 0);
    // Three of the controller's 2-second intervals, by the literal value.
    expect(clock.read(6000).stale).toBe(false);
    expect(clock.read(6001).stale).toBe(true);
    expect(STALE_AFTER_MS).toBe(6000);
    // The next snapshot makes it current again.
    clock.receive(generatedAt, 20_000);
    expect(clock.read(20_000).stale).toBe(false);
  });

  it("falls back to the browser's clock before the first snapshot and for one with no usable time", () => {
    const clock = new PageClock();
    const before = clock.read();
    expect(before.stale).toBe(false);
    expect(Math.abs(before.now - Date.now())).toBeLessThan(1000);
    clock.receive("garbage", 0);
    expect(Math.abs(clock.read(0).now - Date.now())).toBeLessThan(1000);
  });
});

describe("connectionLabel", () => {
  const current = { now: SERVER_NOW, stale: false, silentMs: 1500 };
  const old = { now: SERVER_NOW, stale: true, silentMs: 12_000 };

  it("says what the browser reports while snapshots arrive", () => {
    expect(connectionLabel("connecting", current)).toEqual({ text: "Connecting…", status: "connecting" });
    expect(connectionLabel("live", current)).toEqual({ text: "Live", status: "live" });
    expect(connectionLabel("reconnecting", current)).toEqual({ text: "Reconnecting…", status: "reconnecting" });
  });

  it("says nothing arrives whatever the browser reports: a dropped connection can look open", () => {
    for (const status of ["connecting", "live", "reconnecting"] as const) {
      expect(connectionLabel(status, old)).toEqual({
        text: "Reconnecting… last update 12s ago",
        status: "reconnecting",
      });
    }
    expect(staleNotice(old)).toBe("Reconnecting… last update 12s ago");
  });
});
