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
} {
  const sources = fakeSources();
  const succeeded: Succession[] = [];
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
      keyFramesBack: () => undefined,
    },
    sources.open,
    createLogger("test", "silent"),
    () => 0,
    30_000,
  );
  const run = (mode: FullMode): Generation => {
    const opened = generation(mode);
    stream.open(opened);
    return opened;
  };
  return { feeds: stream, sources: sources.opened, succeeded, run };
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
    const { feeds: stream, sources, succeeded, run } = feeds();
    run("transcode");
    stream.copyFails = true;
    const source = sources.at(-1);
    expect(source?.layout(layoutOf(256))).toBe(false);
    let handedOver: number | undefined;
    for (let at = 0; at <= 120 && handedOver === undefined; at += 2) {
      handedOver = source?.cutPoint(at * 90_000) === true ? at : undefined;
    }
    expect(handedOver).toBe(60);
    expect(succeeded).toEqual([{ layout: layoutOf(256), mode: "copy", midStream: true, drain: true }]);
    expect(stream.copyFails).toBe(false);
    expect(stream.startMode()).toBe("copy");
    expect(source?.request.cutPoints?.watching()).toBe(false);
  });
});
