import { describe, expect, it } from "vitest";
import { CutPointWatch, MAX_STEADY_MS, STEADY_MS } from "../src/cut-point-watch.ts";

const TICKS_PER_SECOND = 90_000;
const WRAP = 2 ** 33;

/** The time stamp of a second of the stream. */
const ptsOf = (seconds: number): number => Math.round((seconds * TICKS_PER_SECOND) % WRAP);

/**
 * Feeds cut points `every` seconds apart from `from` (in seconds of the time stamps) for `seconds`,
 * IDR pictures unless told otherwise; returns when the watch first said yes, in seconds after `from`.
 */
function feed(
  watch: CutPointWatch,
  from: number,
  seconds: number,
  every: number,
  point: "idr" | "recovery-point" = "idr",
): number | undefined {
  for (let at = 0; at <= seconds; at += every) {
    if (watch.cutPoint(ptsOf(from + at), point)) {
      return at;
    }
  }
  return undefined;
}

describe("CutPointWatch", () => {
  it("lets the copy come back once cut points came often enough for a minute", () => {
    const watch = new CutPointWatch(30_000);
    expect(feed(watch, 1000, 120, 2)).toBe(STEADY_MS / 1000);
  });

  it("allows gaps of up to 5 s, or half the stall time when that is shorter", () => {
    expect(feed(new CutPointWatch(30_000), 0, 200, 5)).toBe(60);
    expect(feed(new CutPointWatch(30_000), 0, 200, 5.5)).toBeUndefined();
    expect(feed(new CutPointWatch(8000), 0, 200, 4)).toBe(60);
    expect(feed(new CutPointWatch(8000), 0, 200, 4.5)).toBeUndefined();
  });

  it("starts over after a gap, a step back in the time stamps, or a unit without one", () => {
    const watch = new CutPointWatch(30_000);
    expect(feed(watch, 0, 40, 2)).toBeUndefined();
    // A pause of 20 s: the minute counts from the first cut point after it.
    expect(feed(watch, 60, 58, 2)).toBeUndefined();
    expect(feed(watch, 120, 10, 2)).toBe(0);

    const back = new CutPointWatch(30_000);
    expect(feed(back, 1000, 40, 2)).toBeUndefined();
    expect(feed(back, 900, 58, 2)).toBeUndefined();
    expect(feed(back, 960, 2, 2)).toBe(0);

    const without = new CutPointWatch(30_000);
    expect(feed(without, 0, 40, 2)).toBeUndefined();
    expect(without.cutPoint(undefined, "idr")).toBe(false);
    expect(feed(without, 42, 58, 2)).toBeUndefined();
    expect(feed(without, 102, 2, 2)).toBe(0);

    // The same time stamp again: the clock stands still.
    const still = new CutPointWatch(30_000);
    expect(feed(still, 0, 40, 2)).toBeUndefined();
    expect(feed(still, 40, 58, 2)).toBeUndefined();
    expect(feed(still, 100, 2, 2)).toBe(0);
  });

  it("tells whether every cut point that counted was an IDR picture", () => {
    const watch = new CutPointWatch(30_000);
    expect(feed(watch, 0, 60, 2)).toBe(60);
    expect(watch.onlyIdrs).toBe(true);
    watch.reset();
    expect(feed(watch, 100, 30, 2)).toBeUndefined();
    expect(watch.cutPoint(ptsOf(132), "recovery-point")).toBe(false);
    expect(feed(watch, 134, 30, 2)).toBe(26);
    expect(watch.onlyIdrs).toBe(false);
    // One before a gap that starts the count over doesn't count.
    watch.reset();
    expect(feed(watch, 200, 10, 2, "recovery-point")).toBeUndefined();
    expect(feed(watch, 220, 60, 2)).toBe(60);
    expect(watch.onlyIdrs).toBe(true);
  });

  it("goes on across the wrap of the time stamps", () => {
    const watch = new CutPointWatch(30_000);
    const nearWrap = WRAP / TICKS_PER_SECOND - 30;
    expect(feed(watch, nearWrap, 120, 2)).toBe(60);
  });

  it("waits twice as long after each return that ended in a re-encode again, up to half an hour", () => {
    const watch = new CutPointWatch(30_000);
    expect(watch.waitMs).toBe(STEADY_MS);
    watch.failedAgain(STEADY_MS);
    expect(watch.waitMs).toBe(2 * STEADY_MS);
    expect(feed(watch, 0, 200, 2)).toBe(120);
    for (let time = 0; time < 10; time += 1) {
      watch.failedAgain(MAX_STEADY_MS - 1);
    }
    expect(watch.waitMs).toBe(MAX_STEADY_MS);
  });

  it("waits a minute again after a copy that came back and played for half an hour", () => {
    const watch = new CutPointWatch(30_000);
    watch.failedAgain(STEADY_MS);
    watch.failedAgain(STEADY_MS);
    expect(watch.waitMs).toBe(4 * STEADY_MS);
    watch.failedAgain(MAX_STEADY_MS);
    expect(watch.waitMs).toBe(STEADY_MS);
  });

  it("counts afresh after a reset, as once the copy came back", () => {
    const watch = new CutPointWatch(30_000);
    expect(feed(watch, 0, 60, 2)).toBe(60);
    watch.reset();
    expect(feed(watch, 62, 50, 2)).toBeUndefined();
  });
});
