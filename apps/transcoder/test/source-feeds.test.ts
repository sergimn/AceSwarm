import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { FullMode } from "../src/ffmpeg-args.ts";
import { Generation } from "../src/generation.ts";
import { SourceFeeds, type Succession } from "../src/source-feeds.ts";
import { fakeSources, layoutOf, type FakeSource } from "./fake-source.ts";

const HEVC_TYPE = 0x24;

/** The feeds of a stream whose host starts every run it is asked for, and the sources they opened. */
function feeds(): {
  feeds: SourceFeeds;
  sources: FakeSource[];
  succeeded: Succession[];
  run: (mode: FullMode) => Generation;
  /** How many times key frames only decoding came back. */
  backs: { count: number };
  clock: { now: number };
} {
  const sources = fakeSources();
  const succeeded: Succession[] = [];
  const backs = { count: 0 };
  const clock = { now: 0 };
  let number = 0;
  const generation = (mode: FullMode): Generation => {
    number += 1;
    const plan = { number, source: "http://engine/play", directory: `/nowhere/g${String(number)}`, mode };
    const made = new Generation({ ...plan, allFrames: false, startedAt: 0, inputTimeoutSeconds: 60 });
    // Its ffmpeg's input, as each run has one of its own.
    made.sink = { write: () => Promise.resolve(), end: () => undefined };
    return made;
  };
  const stream = new SourceFeeds(
    {
      succeed: (old, how) => {
        succeeded.push(how);
        const next = generation(how.mode);
        next.takeOver(old, how.layout);
        return next;
      },
      publish: () => Promise.resolve(),
      retire: () => undefined,
      moved: () => undefined,
      keyFramesBack: () => {
        backs.count += 1;
      },
    },
    sources.open,
    createLogger("test", "silent"),
    () => clock.now,
    { stallMs: 30_000, segmentMs: 2000 },
  );
  const run = (mode: FullMode): Generation => {
    const opened = generation(mode);
    stream.open(opened);
    return opened;
  };
  return { feeds: stream, sources: sources.opened, succeeded, run, backs, clock };
}

/**
 * Cut points every 2 s from `from` (in seconds of the time stamps) for up to `seconds`, IDR
 * pictures unless `point` says otherwise for one; returns when the feeds handed over, in seconds after `from`.
 */
function cutPoints(
  source: FakeSource | undefined,
  from: number,
  seconds: number,
  point: (at: number) => "idr" | "recovery-point" = () => "idr",
): number | undefined {
  for (let at = 0; at <= seconds; at += 2) {
    if (source?.cutPoint((from + at) * 90_000, point(at)) === true) {
      return at;
    }
  }
  return undefined;
}

/** A stream that re-encodes because a copy failed, with a run that watches its H.264 source. */
function reencoding(): ReturnType<typeof feeds> & { source: FakeSource | undefined } {
  const made = feeds();
  made.run("transcode");
  made.feeds.copyFails = true;
  const source = made.sources.at(-1);
  expect(source?.layout(layoutOf(256))).toBe(false);
  return { ...made, source };
}

describe("SourceFeeds watching for key frames", () => {
  it("watches only while a copy failed, and only a run that re-encodes H.264 that a copy could come back for", () => {
    const { feeds: stream, sources, run } = feeds();
    const reencoding = run("transcode");
    const source = sources.at(-1);
    expect(source?.request.cutPoints?.watching()).toBe(false);
    stream.copyFails = true;
    // Its tables say nothing yet.
    expect(source?.request.cutPoints?.watching()).toBe(false);
    expect(source?.layout(layoutOf(256))).toBe(false);
    expect(source?.request.cutPoints?.watching()).toBe(true);
    // ffmpeg found it to be HEVC after all.
    expect(stream.found(reencoding, "hevc")).toBe("transcode");
    expect(source?.request.cutPoints?.watching()).toBe(false);
    expect(stream.found(reencoding, "h264")).toBe("transcode");
    expect(source?.request.cutPoints?.watching()).toBe(true);

    // A run whose video is HEVC by its tables.
    run("transcode");
    expect(sources.at(-1)?.layout(layoutOf(256, HEVC_TYPE))).toBe(false);
    expect(sources.at(-1)?.request.cutPoints?.watching()).toBe(false);

    reencoding.retired = true;
    expect(source?.request.cutPoints?.watching()).toBe(false);
  });

  it("leaves alone a run that began to copy before a copy failed: it copies already", () => {
    const { feeds: stream, sources, run } = feeds();
    run("copy");
    const source = sources.at(-1);
    expect(source?.layout(layoutOf(256))).toBe(false);
    stream.copyFails = true;
    expect(source?.request.cutPoints?.watching()).toBe(false);
    expect(source?.cutPoint(0)).toBe(false);
  });

  it("hands over to a run that copies, which drains the old one, and watches no more", () => {
    const { feeds: stream, source, succeeded, backs } = reencoding();
    expect(cutPoints(source, 0, 120)).toBe(60);
    expect(succeeded).toEqual([{ layout: layoutOf(256), mode: "copy", midStream: true, drain: true }]);
    expect(stream.copyFails).toBe(false);
    expect(stream.startMode()).toBe("copy");
    expect(source?.request.cutPoints?.watching()).toBe(false);
    expect(backs.count).toBe(1);
  });

  it("decodes key frames only again only where every cut point of the minute was an IDR picture", () => {
    const { source, backs } = reencoding();
    expect(cutPoints(source, 0, 120, (at) => (at === 30 ? "recovery-point" : "idr"))).toBe(60);
    expect(backs.count).toBe(0);
  });

  it("starts the count over at a change of layout or a move to other PIDs, but not at tables that change around the run's streams", () => {
    const { source } = reencoding();
    expect(cutPoints(source, 0, 30)).toBeUndefined();
    // The program's table on another PID.
    source?.move(layoutOf(256, 0x1b, 0x20_00), true);
    expect(cutPoints(source, 32, 30)).toBe(28);

    const moved = reencoding().source;
    expect(cutPoints(moved, 0, 30)).toBeUndefined();
    // The same streams on other PIDs, maybe from another encoder.
    moved?.move(layoutOf(211));
    expect(cutPoints(moved, 32, 56)).toBeUndefined();
    expect(cutPoints(moved, 90, 2)).toBe(2);

    // A change of layout, which a new run on the same connection takes over at.
    const { source: changed, succeeded } = reencoding();
    expect(cutPoints(changed, 0, 30)).toBeUndefined();
    expect(changed?.layout(layoutOf(300))).toBe(true);
    expect(succeeded.map((how) => how.mode)).toEqual(["transcode"]);
    expect(cutPoints(changed, 32, 56)).toBeUndefined();
    expect(cutPoints(changed, 90, 2)).toBe(2);
  });

  it("waits twice as long after a copy that failed again, and a minute again after one that played for half an hour", () => {
    const { feeds: stream, source, sources, run, clock } = reencoding();
    expect(cutPoints(source, 0, 60)).toBe(60);
    /** The copy fails again after that long, and a run re-encodes the stream from a source of its own. */
    const failsAfter = (ms: number): FakeSource | undefined => {
      clock.now += ms;
      stream.copyFails = true;
      run("transcode");
      const next = sources.at(-1);
      expect(next?.layout(layoutOf(256))).toBe(false);
      return next;
    };
    expect(cutPoints(failsAfter(2 * 60_000), 0, 200)).toBe(120);
    expect(cutPoints(failsAfter(29 * 60_000), 0, 400)).toBe(240);
    expect(cutPoints(failsAfter(30 * 60_000), 0, 200)).toBe(60);
  });
});
