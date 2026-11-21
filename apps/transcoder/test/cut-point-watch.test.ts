import { describe, expect, it } from "vitest";
import { CutPointWatch, MAX_STEADY_MS, STEADY_MS } from "../src/cut-point-watch.ts";

const TICKS_PER_SECOND = 90_000;
const WRAP = 2 ** 33;

/** A watch for a stall time of 30 s and segments of 2 s, unless told otherwise. */
const watchOf = (stallMs = 30_000, segmentMs = 2000): CutPointWatch => new CutPointWatch({ stallMs, segmentMs });

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

/**
 * Feeds IDR pictures with these gaps (seconds), over and over, for 200 s from `from` (in seconds of
 * the time stamps); returns when the watch first said yes, in seconds after `from`.
 */
function feedGaps(watch: CutPointWatch, gaps: readonly number[], from = 0): number | undefined {
  let at = 0;
  for (let index = 0; at <= 200; index += 1) {
    if (watch.cutPoint(ptsOf(from + at), "idr")) {
      return at;
    }
    at += gaps[index % gaps.length] ?? 1;
  }
  return undefined;
}

describe("CutPointWatch", () => {
  it("lets the copy come back once cut points came often enough for a minute", () => {
    const watch = watchOf();
    expect(feed(watch, 1000, 120, 2)).toBe(STEADY_MS / 1000);
  });

  it("allows gaps of up to 5 s, or half the stall time when that is shorter", () => {
    expect(feed(watchOf(), 0, 200, 5)).toBe(60);
    expect(feed(watchOf(), 0, 200, 5.5)).toBeUndefined();
    // A little more: a key frame every 150 frames at 29.97 frames a second.
    expect(feed(watchOf(), 0, 200, 5.005)).toBeGreaterThanOrEqual(60);
    expect(feed(watchOf(), 0, 200, 5.2)).toBeUndefined();
    expect(feed(watchOf(8000), 0, 200, 4)).toBe(60);
    expect(feed(watchOf(8000), 0, 200, 4.5)).toBeUndefined();
  });

  it("allows no cut points so uneven that the first segment of a copy begun at one would be longer than 5 s", () => {
    // 1.8 s, then 5 s: a copy begun before the short gap ends its first segment 6.8 s on.
    expect(feedGaps(watchOf(), [1.8, 5])).toBeUndefined();
    // 1.5 s, then 3.4 s: 4.9 s.
    expect(feedGaps(watchOf(), [1.5, 3.4])).toBeGreaterThanOrEqual(60);
    // 1.9 s, then 3.3 s: 5.2 s, longer than the rounding allows.
    expect(feedGaps(watchOf(), [1.9, 3.3])).toBeUndefined();
  });

  it("allows a first segment as long as a segment, where segments are longer than that", () => {
    expect(feed(watchOf(30_000, 6000), 0, 200, 2)).toBe(60);
    expect(feed(watchOf(30_000, 6000), 0, 200, 3)).toBe(60);
    // Every 4 s: the first segment ends 8 s on.
    expect(feed(watchOf(30_000, 6000), 0, 200, 4)).toBeUndefined();
    // A key frame every 60 frames at 29.97 frames a second: three of them last 6.006 s.
    expect(feed(watchOf(30_000, 6000), 0, 200, 2.002)).toBeGreaterThanOrEqual(60);
    // And every 30 for segments of 5 s: 5.005 s.
    expect(feed(watchOf(30_000, 5000), 0, 200, 1.001)).toBeGreaterThanOrEqual(60);
  });

  it("starts over after a gap, a step back in the time stamps, or a unit without one", () => {
    const watch = watchOf();
    expect(feed(watch, 0, 40, 2)).toBeUndefined();
    // A pause of 20 s: the minute counts from the first cut point after it.
    expect(feed(watch, 60, 58, 2)).toBeUndefined();
    expect(feed(watch, 120, 10, 2)).toBe(0);

    const back = watchOf();
    expect(feed(back, 1000, 40, 2)).toBeUndefined();
    expect(feed(back, 900, 58, 2)).toBeUndefined();
    expect(feed(back, 960, 2, 2)).toBe(0);

    const without = watchOf();
    expect(feed(without, 0, 40, 2)).toBeUndefined();
    expect(without.cutPoint(undefined, "idr")).toBe(false);
    expect(feed(without, 42, 58, 2)).toBeUndefined();
    expect(feed(without, 102, 2, 2)).toBe(0);

    // The same time stamp again: the clock stands still.
    const still = watchOf();
    expect(feed(still, 0, 40, 2)).toBeUndefined();
    expect(feed(still, 40, 58, 2)).toBeUndefined();
    expect(feed(still, 100, 2, 2)).toBe(0);
  });

  it("tells whether every cut point that counted was an IDR picture", () => {
    const watch = watchOf();
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
    const watch = watchOf();
    const nearWrap = WRAP / TICKS_PER_SECOND - 30;
    expect(feed(watch, nearWrap, 120, 2)).toBe(60);
    // A first segment is timed across it too.
    expect(feedGaps(watchOf(), [1.8, 5], nearWrap)).toBeUndefined();
    expect(feedGaps(watchOf(), [1.5, 3.4], nearWrap)).toBeGreaterThanOrEqual(60);
  });

  it("waits twice as long after each return that ended in a re-encode again, up to half an hour", () => {
    const watch = watchOf();
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
    const watch = watchOf();
    watch.failedAgain(STEADY_MS);
    watch.failedAgain(STEADY_MS);
    expect(watch.waitMs).toBe(4 * STEADY_MS);
    watch.failedAgain(MAX_STEADY_MS);
    expect(watch.waitMs).toBe(STEADY_MS);
  });

  it("counts afresh after a reset, as once the copy came back", () => {
    const watch = watchOf();
    expect(feed(watch, 0, 60, 2)).toBe(60);
    watch.reset();
    expect(feed(watch, 62, 50, 2)).toBeUndefined();
  });
});
