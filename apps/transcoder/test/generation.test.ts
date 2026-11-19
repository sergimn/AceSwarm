import { describe, expect, it } from "vitest";
import { Generation } from "../src/generation.ts";
import { LiveEdge } from "../src/live-edge.ts";

function generation(): Generation {
  const run = new Generation({
    number: 1,
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
    clock.now += 7000;
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
  });

  it.each([
    ["retired", (run: Generation) => (run.retired = true)],
    ["exited", (run: Generation) => (run.state = "exited")],
    ["showing a frame", (run: Generation) => (run.frames = 1)],
  ])("sees no flow of a run that is %s", (_name, change) => {
    const run = generation();
    expect(run.watchFlow(1000, 0)).toBe("flowing");
    change(run);
    expect(run.watchFlow(5000, 0)).toBe("unknown");
    expect(run.flowedMs()).toBe(0);
  });
});
