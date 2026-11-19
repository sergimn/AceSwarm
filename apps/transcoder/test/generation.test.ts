import { describe, expect, it } from "vitest";
import { Generation } from "../src/generation.ts";
import { LiveEdge } from "../src/live-edge.ts";
import { layoutOf } from "./fake-source.ts";

function generation(number = 1): Generation {
  const run = new Generation({
    number,
    source: "http://e1/play",
    directory: "/hls/s1/1",
    mode: "copy",
    allFrames: false,
    startedAt: 0,
    inputTimeoutSeconds: 60,
  });
  run.videoCodec = "h264";
  return run;
}

describe("Generation flow", () => {
  it("starts over, with what earlier runs saw, when the data stops coming for a while", () => {
    const edge = new LiveEdge({ staleAfterMs: 60_000, noLiveAfterPolls: 10 }, () => clock.now);
    const clock = { now: 1_000_000 };
    const run = generation();
    run.watch = { edge, stop: () => undefined };
    for (let step = 0; step < 6; step += 1) {
      clock.now += 1000;
      const last = 5000 + clock.now / 1000;
      edge.observe({ status: "dl", downloaded: clock.now, last, pos: last });
    }
    expect(run.watchFlow(clock.now, 7000)).toBe("flowing");
    clock.now += 4000;
    expect(run.watchFlow(clock.now, 7000)).toBe("flowing");
    expect(run.flowedMs()).toBe(11_000);
    clock.now += 21_000;
    expect(run.watchFlow(clock.now, 7000)).toBe("paused");
    expect(run.flowedMs()).toBe(0);
  });

  it("counts how long the data came, with what earlier runs saw", () => {
    const run = generation();
    expect(run.flowedMs()).toBe(0);
    expect(run.watchFlow(10_000, 7000)).toBe("flowing");
    expect(run.watchFlow(15_000, 7000)).toBe("flowing");
    expect(run.flowedMs()).toBe(12_000);
    // What earlier runs saw counts from when the data begins to come, not later.
    expect(run.watchFlow(20_000, 99_000)).toBe("flowing");
    expect(run.flowedMs()).toBe(17_000);
  });

  it("knows nothing until ffmpeg knows the video, and starts over", () => {
    const run = generation();
    run.videoCodec = undefined;
    expect(run.watchFlow(10_000, 7000)).toBe("unknown");
    run.videoCodec = "h264";
    expect(run.watchFlow(11_000, 7000)).toBe("flowing");
    expect(run.watchFlow(16_000, 7000)).toBe("flowing");
    run.videoCodec = undefined;
    expect(run.watchFlow(17_000, 7000)).toBe("unknown");
    // What came before still counts, the run's own time starts over.
    expect(run.flowedMs()).toBe(7000);
    // And it does not count twice when the data comes again.
    run.videoCodec = "h264";
    expect(run.watchFlow(20_000, 7000)).toBe("flowing");
    expect(run.watchFlow(22_000, 7000)).toBe("flowing");
    expect(run.flowedMs()).toBe(9000);
  });

  it.each([
    ["retired", (run: Generation) => (run.retired = true)],
    ["exited", (run: Generation) => (run.state = "exited")],
    ["showing a frame", (run: Generation) => (run.frames = 1)],
  ])("sees no more flow of a run that is %s", (_name, change) => {
    const run = generation();
    expect(run.watchFlow(1000, 0)).toBe("flowing");
    expect(run.watchFlow(5000, 0)).toBe("flowing");
    change(run);
    expect(run.watchFlow(9000, 0)).toBe("unknown");
    // What it saw is handed on to the run that replaces it, and does not grow.
    expect(run.flowedMs()).toBe(4000);
  });
});

/** A run that reads its source through a connection, and whether that was stopped. */
function connected(): { run: Generation; reader: { stopped: boolean } } {
  const run = generation();
  const reader = { stopped: false };
  run.connection = {
    run,
    reader: {
      stop: () => {
        reader.stopped = true;
      },
      status: () => ({ bytes: 0, lastDataAt: undefined, layout: undefined }),
    },
  };
  return { run, reader };
}

describe("Generation.takeOver", () => {
  it("gets what belongs to the session: the connection, the live edge's watch and the handover it is part of", () => {
    const { run: old, reader } = connected();
    const edge = new LiveEdge({ staleAfterMs: 60_000, noLiveAfterPolls: 10 }, () => 0);
    const watch = { edge, stop: () => undefined };
    old.watch = watch;
    old.reopens = 3;
    old.handoverSince = 500;
    old.publishedFrameAt = 900;
    const next = generation(2);
    const layout = layoutOf(211);
    next.takeOver(old, layout);

    expect(next.layout).toBe(layout);
    expect(next.connection?.run).toBe(next);
    expect(old.connection).toBeUndefined();
    expect(next.watch).toBe(watch);
    expect(old.watch).toBeUndefined();
    expect(next).toMatchObject({ reopens: 3, handoverSince: 500, publishedFrameAt: 900, published: false });

    // The old run's end leaves the source alone; the new run's does not.
    old.halt();
    expect(reader.stopped).toBe(false);
    next.halt();
    expect(reader.stopped).toBe(true);
  });

  it("may publish all it writes when the run before it could: everything it reads comes after", () => {
    const { run: old } = connected();
    old.publishingSince = 700;
    old.publishFrom.full = 4;
    old.publishFrom.preview = 5;
    const next = generation(2);
    next.takeOver(old, layoutOf(211));
    expect(next.publishingSince).toBe(700);
    expect(next.publishFrom).toEqual({ full: -1, preview: -1 });
  });

  it("waits like the run before it for a live edge that was not seen to move yet", () => {
    const { run: old } = connected();
    const next = generation(2);
    next.takeOver(old, layoutOf(211));
    expect(next.publishingSince).toBeUndefined();
    expect(next.publishFrom).toEqual({});
  });
});
