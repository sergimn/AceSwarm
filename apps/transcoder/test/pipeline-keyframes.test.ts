import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createLogger } from "@aceswarm/shared/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEdge } from "../src/live-edge.ts";
import { KEY_FRAMES_PATIENCE_MS } from "../src/key-frames.ts";
import { Pipeline, type PipelineSettings } from "../src/pipeline.ts";

const H264 = "  Stream #0:0[0x100]: Video: h264 (High), yuv420p(progressive), 1280x720, 25 fps\n";
const MPEG2 = "  Stream #0:0[0x100]: Video: mpeg2video (Main), yuv420p(tv), 720x576, 25 fps\n";

/** An ffmpeg process that runs until the test ends it. */
function fakeFfmpeg(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => {
      Object.assign(child, { killed: true });
      // ffmpeg 9 prints a last block as it is stopped, though it printed none before.
      (child.stdout as PassThrough).write("frame=119\nfps=25\nprogress=end\n");
      return true;
    },
  });
  return child;
}

/** An ffmpeg run that ends, as when the engine refuses the connection. */
function exit(child: ChildProcess | undefined): void {
  const code = 183;
  Object.assign(child ?? {}, { exitCode: code });
  (child?.stderr as PassThrough | undefined)?.write(
    "Error opening input files: Invalid data found when processing input\n",
  );
  child?.emit("exit", code, null);
}

/** Whether an ffmpeg run decodes key frames only. */
function skipsFrames(args: string[] | undefined): boolean {
  return args?.includes("-skip_frame") === true;
}

/** How long a run waits for its source's data, as ffmpeg gets it (microseconds). */
function inputTimeout(args: string[] = []): string | undefined {
  return args[args.indexOf("-rw_timeout") + 1];
}

/** The filter of a run's preview output: the one whose scale is to the preview's height. */
function previewFilter(args: string[] | undefined): string | undefined {
  return args?.find((arg) => arg.includes("scale=-2:270"));
}

describe("Pipeline decoding key frames only", () => {
  let hlsDir: string;
  let pipeline: Pipeline | undefined;
  /** The arguments of every ffmpeg run, in order, and its process. */
  const runs: string[][] = [];
  const children: ChildProcess[] = [];
  /** Why each run started. */
  const reasons: string[] = [];
  /** The live edge each run follows, in order. */
  const edges: { edge: LiveEdge }[] = [];
  const clock = { now: 1_000_000 };
  /** The pipeline's logger for its stream, whose warnings the tests look at. */
  const streamLogger = createLogger("test", "silent");
  let warn = vi.spyOn(streamLogger, "warn");

  beforeEach(async () => {
    warn = vi.spyOn(streamLogger, "warn");
    hlsDir = await mkdtemp(join(tmpdir(), "pipeline-keyframes-test-"));
    runs.length = 0;
    children.length = 0;
    reasons.length = 0;
    edges.length = 0;
    clock.now = 1_000_000;
  });

  afterEach(async () => {
    await pipeline?.stop();
    await rm(hlsDir, { recursive: true, force: true });
  });

  function start(previewMode: "video" | "keyframes" | "thumbnails" = "keyframes"): Pipeline {
    const settings: PipelineSettings = {
      hlsDir,
      ffmpegPath: "ffmpeg",
      handoverTimeoutMs: 120_000,
      plan: {
        previewMode,
        previewHeight: 270,
        previewFps: 15,
        previewBitrateKbps: 400,
        fullTranscodeMaxHeight: 1080,
        audioBitrateKbps: 128,
        segmentSeconds: 2,
        playlistSize: 6,
        thumbnailIntervalSeconds: 10,
        inputTimeoutSeconds: 60,
      },
      liveEdge: { staleAfterMs: 60_000, noLiveAfterPolls: 10 },
    };
    const events = {
      generationStarted: (_id: string, reason: string) => {
        reasons.push(reason);
      },
      handover: () => undefined,
    };
    const logger = createLogger("test", "silent");
    vi.spyOn(logger, "child").mockReturnValue(streamLogger as never);
    pipeline = new Pipeline("s1", settings, logger, events, {
      spawner: (_command, args) => {
        runs.push(args);
        const child = fakeFfmpeg();
        children.push(child);
        return child;
      },
      now: () => clock.now,
      watchLiveEdge: (_url, edge) => {
        edges.push({ edge });
        return { edge, stop: () => undefined };
      },
    });
    return pipeline;
  }

  /** ffmpeg of a run (the first by default) has read enough of its source to know its video. */
  async function opened(run = 0, line = H264): Promise<void> {
    (children[run]?.stderr as PassThrough).write(line);
    await nextTurn();
  }

  /** ffmpeg of a run reports its progress: a frame came of its work. */
  async function frames(frame: number, run = 0): Promise<void> {
    (children[run]?.stdout as PassThrough).write(`frame=${String(frame)}\nfps=25\nprogress=continue\n`);
    await nextTurn();
  }

  /** The session's live edge of a run moves a second each second, and it downloads. */
  function live(run = 0): void {
    for (let step = 0; step <= 3; step += 1) {
      clock.now += step === 0 ? 0 : 1000;
      const last = 5000 + clock.now / 1000;
      edges[run]?.edge.observe({ status: "dl", downloaded: clock.now, last, pos: last });
    }
  }

  /** The live edges move on, as the broadcast sends new data. */
  function moves(seconds: number): void {
    clock.now += seconds * 1000;
    const last = 5000 + clock.now / 1000;
    for (const { edge } of edges) {
      edge.observe({ status: "dl", downloaded: clock.now, last, pos: last });
    }
  }

  /** Waits until `count` ffmpeg runs started (a run starts after its directories exist). */
  async function runsStarted(count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(runs).toHaveLength(count);
    });
  }

  /** Gives a run that should not start the time to: it would start after its directories exist. */
  async function noMoreRuns(count: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runs).toHaveLength(count);
  }

  it("decodes every frame once the source gave no frame for the patience, on every source after", async () => {
    const instance = start();
    expect(instance.decoding()).toBeUndefined();
    await instance.start("http://e1/play", false);
    expect(skipsFrames(runs[0])).toBe(true);
    expect(previewFilter(runs[0])).toBe("scale=-2:270");
    expect(instance.decoding()).toBe("key-frames-waiting");
    await opened();
    await instance.sync();

    // Keyframes mode may take a while to show a first frame from a broadcast whose key frames
    // come every few seconds: 45 seconds, as the documentation says.
    clock.now += 44_000;
    await instance.sync();
    await noMoreRuns(1);

    clock.now += 1000;
    await instance.sync();
    await runsStarted(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1 }),
      "key frames only decoding gave no frame; decoding every frame",
    );
    expect(children[0]?.killed).toBe(true);
    expect(skipsFrames(runs[1])).toBe(false);
    // With every frame decoded, the preview thins them out as in video mode.
    expect(previewFilter(runs[1])).toBe("fps=15,scale=-2:270");
    expect(reasons).toEqual(["start", "all-frames"]);
    expect(instance.status()).toMatchObject({ source: "http://e1/play", state: "starting", frames: 0 });
    expect(instance.decoding()).toBe("all-frames-fallback");

    // The new run counts: it is the same source, and a new one gets the same treatment.
    await opened(1);
    await frames(25, 1);
    expect(instance.status()).toMatchObject({ state: "running", frames: 25 });
    await instance.start("http://e2/play", false);
    expect(skipsFrames(runs[2])).toBe(false);
    expect(reasons).toEqual(["start", "all-frames", "restart"]);
    expect(instance.decoding()).toBe("all-frames-fallback");
  });

  it("starts one run, whatever many syncs ask at once", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS;
    await Promise.all([instance.sync(), instance.sync(), instance.playlist("full")]);
    await runsStarted(2);
    await noMoreRuns(2);
    expect(children.filter((child) => !child.killed)).toHaveLength(1);
  });

  it("goes on with key frames only decoding once a frame came, however late", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS - 1000;
    expect(instance.decoding()).toBe("key-frames-waiting");
    await frames(1);
    expect(instance.decoding()).toBe("key-frames");
    await instance.sync();
    clock.now += 60_000;
    await instance.sync();
    await noMoreRuns(1);
    expect(instance.status().state).toBe("running");
    await instance.start("http://e2/play", false);
    expect(skipsFrames(runs[1])).toBe(true);
    // The new source has given no frame yet, but the broadcast has key frames ffmpeg can use.
    expect(instance.decoding()).toBe("key-frames");
  });

  it("waits for the source's data: ffmpeg that knows no video yet is still waiting for the engine", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await instance.sync();
    clock.now += 10 * KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await noMoreRuns(1);
    // The patience counts from the first data, not from when ffmpeg started.
    await opened();
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS - 1000;
    await instance.sync();
    await noMoreRuns(1);
  });

  it("waits for the source's live edge to move, and counts from then", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    // The engine serves what it has, but its live edge has not moved.
    await instance.sync();
    clock.now += 5 * KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await noMoreRuns(1);

    live();
    await instance.sync();
    moves(KEY_FRAMES_PATIENCE_MS / 1000 - 1);
    await instance.sync();
    await noMoreRuns(1);
    moves(1);
    await instance.sync();
    await runsStarted(2);
    // The new run follows the session's live edge again, from what the stream saw.
    expect(edges).toHaveLength(2);
    expect(skipsFrames(runs[1])).toBe(false);
  });

  it("does not decode every frame in video mode, which does not skip any", async () => {
    const instance = start("video");
    await instance.start("http://e1/play", false);
    await opened();
    await instance.sync();
    clock.now += 10 * KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await noMoreRuns(1);
    expect(instance.decoding()).toBe("all-frames");
  });

  it("does not start a source it stopped reading as stale again", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    // The broadcast stops: the engine keeps answering, with the same live edge.
    clock.now += 30_000;
    edges[0]?.edge.observe({ status: "dl", downloaded: 400, last: 5003, pos: 5003 });
    clock.now += 31_000;
    edges[0]?.edge.observe({ status: "dl", downloaded: 400, last: 5003, pos: 5003 });
    await instance.sync();
    expect(children[0]?.killed).toBe(true);
    expect(instance.status().liveEdge?.state).toBe("stale");
    await instance.sync();
    await noMoreRuns(1);
  });

  it("decodes every frame of a handover's source whose first source shows nothing either", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    await instance.start("http://e2/play", true, 0, "http://e2/stat");
    expect(instance.status().pendingSource).toBe("http://e2/play");
    await opened(1);
    live(1);
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS;
    edges[1]?.edge.observe({
      status: "dl",
      downloaded: 900,
      last: 5000 + clock.now / 1000,
      pos: 5000 + clock.now / 1000,
    });
    await instance.sync();
    await runsStarted(3);
    expect(children[1]?.killed).toBe(true);
    expect(children[0]?.killed).toBe(false);
    expect(skipsFrames(runs[2])).toBe(false);
    expect(reasons).toEqual(["start", "handover", "all-frames"]);
    // The handover goes on with that run, and the time a handover has to get its data.
    expect(instance.status()).toMatchObject({ source: "http://e1/play", pendingSource: "http://e2/play" });
    expect(inputTimeout(runs[0])).toBe("60000000");
    expect(inputTimeout(runs[1])).toBe("120000000");
    expect(inputTimeout(runs[2])).toBe("120000000");
  });

  it("does not take a slow handover's source for a broadcast without key frames once frames came", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await frames(50);
    await instance.start("http://e2/play", true);
    await opened(1);
    await instance.sync();
    // Longer than the patience, shorter than the time a handover has (else it times out, not this).
    clock.now += 2 * KEY_FRAMES_PATIENCE_MS;
    expect(2 * KEY_FRAMES_PATIENCE_MS).toBeLessThan(120_000);
    await instance.sync();
    await noMoreRuns(2);
    expect(children[1]?.killed).toBe(false);
    // The next source keeps decoding key frames only.
    await instance.start("http://e3/play", false);
    expect(skipsFrames(runs[2])).toBe(true);
  });

  it("does not take a source that sends slowly for a broadcast without key frames once frames came", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await frames(50);
    // A new source, no handover: its first frame takes its time, the broadcast has key frames.
    await instance.start("http://e2/play", false);
    await opened(1);
    await instance.sync();
    clock.now += 2 * KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await noMoreRuns(2);
    expect(children[1]?.killed).toBe(false);
  });

  it("starts the run of a source that began before the broadcast was known to need every frame at once", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    await instance.start("http://e2/play", true, 0, "http://e2/stat");
    await opened(1);
    moves(15);
    live(1);
    await instance.sync();
    // The first source has waited the patience, the second source has not.
    moves(KEY_FRAMES_PATIENCE_MS / 1000 - 18);
    await instance.sync();
    await runsStarted(3);
    expect(reasons).toEqual(["start", "handover", "all-frames"]);
    await instance.sync();
    await runsStarted(4);
    expect(reasons).toEqual(["start", "handover", "all-frames", "all-frames"]);
  });

  it("gives up on a handover that timed out instead of starting it again", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await instance.start("http://e2/play", true);
    await opened(1);
    await instance.sync();
    clock.now += 121_000;
    await instance.sync();
    await noMoreRuns(2);
    expect(instance.status().pendingSource).toBeNull();
  });

  it("decodes every frame of a re-encoded full stream too, whose frames key frames only starved", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened(0, MPEG2);
    await runsStarted(2);
    expect(runs[1]).toContain("libx264");
    expect(skipsFrames(runs[1])).toBe(true);

    await opened(1, MPEG2);
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await runsStarted(3);
    expect(runs[2]).toContain("libx264");
    expect(skipsFrames(runs[2])).toBe(false);
    expect(reasons).toEqual(["start", "transcode", "all-frames"]);
    expect(instance.decoding()).toBe("all-frames-fallback");
  });

  it("waits the patience again when the data stops coming for a while", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    // The engine keeps answering, but its edge does not move: the broadcast sends nothing.
    for (let step = 0; step < 6; step += 1) {
      clock.now += 5000;
      await instance.sync();
    }
    await noMoreRuns(1);
    // It sends again, and the patience counts from there.
    moves(1);
    await instance.sync();
    moves(KEY_FRAMES_PATIENCE_MS / 1000 - 1);
    await instance.sync();
    await noMoreRuns(1);
    moves(1);
    await instance.sync();
    await runsStarted(2);
  });

  it("does not start a run that decodes every frame again when it gets no frame either", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await runsStarted(2);
    await opened(1);
    await instance.sync();
    clock.now += 3 * KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await noMoreRuns(2);
    expect(children[1]?.killed).toBe(false);
  });

  it("does not take a run that ended for one with no key frames to decode", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await instance.sync();
    exit(children[0]);
    clock.now += 3 * KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await noMoreRuns(1);
    await instance.start("http://e2/play", false);
    expect(skipsFrames(runs[1])).toBe(true);
  });

  it("takes no frame for a sign of key frames from the last block of a run that was stopped", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await instance.sync();
    // A source replaced before it showed anything: ffmpeg prints a last block, with the frames it copied.
    await instance.start("http://e2/play", false);
    await opened(1);
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await runsStarted(3);
    expect(reasons).toEqual(["start", "restart", "all-frames"]);
    expect(skipsFrames(runs[2])).toBe(false);
  });

  it("takes no frame for a sign of key frames from the last block of a source it stopped as stale", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    // The broadcast stops: the engine keeps answering, with the same live edge, until the source is stale.
    clock.now += 61_000;
    edges[0]?.edge.observe({ status: "dl", downloaded: clock.now, last: 5000, pos: 5000 });
    await instance.sync();
    expect(children[0]?.killed).toBe(true);
    await nextTurn();

    await instance.start("http://e2/play", false, 0, "http://e2/stat");
    await opened(1);
    live(1);
    await instance.sync();
    moves(KEY_FRAMES_PATIENCE_MS / 1000);
    await instance.sync();
    await runsStarted(3);
    expect(skipsFrames(runs[2])).toBe(false);
  });

  it("counts a session without a live position, whose output is published as it comes", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    for (let poll = 0; poll < 10; poll += 1) {
      edges[0]?.edge.observe({ status: "dl", downloaded: 100, last: undefined, pos: undefined });
    }
    expect(instance.status().liveEdge?.state).toBe("none");
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await runsStarted(2);
  });

  it("does not start the wait over for a short pause of the live edge", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    for (let step = 0; step < 6; step += 1) {
      moves(5);
      clock.now += 5000;
      await instance.sync();
    }
    await runsStarted(2);
  });

  it("does not count a session whose live edge moves but is not verified as live yet", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    // The edge moves, but the session downloads nothing: it may serve an old window.
    for (let step = 0; step < 12; step += 1) {
      clock.now += 5000;
      const last = 5000 + clock.now / 1000;
      edges[0]?.edge.observe({ status: "dl", downloaded: 100, last, pos: last });
      await instance.sync();
    }
    expect(instance.status().liveEdge?.state).toBe("waiting");
    await noMoreRuns(1);
  });

  it("swaps a handover's run that began before the change at once, though the run that replaced the active one has frames", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    await instance.start("http://e2/play", true, 0, "http://e2/stat");
    await opened(1);
    moves(15);
    live(1);
    await instance.sync();
    moves(KEY_FRAMES_PATIENCE_MS / 1000 - 18);
    await instance.sync();
    await runsStarted(3);
    expect(reasons).toEqual(["start", "handover", "all-frames"]);

    // The run that decodes every frame shows a picture. That says nothing of key frames only decoding.
    await opened(2);
    await frames(25, 2);
    await instance.sync();
    await runsStarted(4);
    expect(reasons).toEqual(["start", "handover", "all-frames", "all-frames"]);
    expect(skipsFrames(runs[3])).toBe(false);
  });

  it("counts a live edge that moved 20 seconds ago, not one that moved a moment longer ago", async () => {
    // The data comes for the patience, with the last move of the edge exactly that long before.
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    moves(KEY_FRAMES_PATIENCE_MS / 1000 - 20);
    clock.now += 20_000;
    await instance.sync();
    await runsStarted(2);
    await instance.stop();

    // A moment longer, and the data stopped for a while: the wait starts over.
    runs.length = 0;
    children.length = 0;
    edges.length = 0;
    const other = start();
    await other.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await other.sync();
    moves(KEY_FRAMES_PATIENCE_MS / 1000 - 20);
    clock.now += 20_001;
    await other.sync();
    await noMoreRuns(1);
  });

  it("decodes every frame in thumbnails mode too, which makes no preview", async () => {
    const instance = start("thumbnails");
    await instance.start("http://e1/play", false);
    expect(skipsFrames(runs[0])).toBe(true);
    expect(runs[0]?.some((arg) => arg.includes("/preview/"))).toBe(false);
    expect(instance.decoding()).toBe("key-frames-waiting");
    await opened();
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS - 1000;
    await instance.sync();
    await noMoreRuns(1);
    clock.now += 1000;
    await instance.sync();
    await runsStarted(2);
    expect(skipsFrames(runs[1])).toBe(false);
    // Still no preview, only the thumbnail needs the frames.
    expect(runs[1]?.some((arg) => arg.includes("/preview/"))).toBe(false);
    expect(runs[1]?.some((arg) => arg.endsWith("/thumbnail.jpg"))).toBe(true);
    expect(reasons).toEqual(["start", "all-frames"]);
    await opened(1);
    await frames(25, 1);
    expect(instance.status()).toMatchObject({ state: "running", frames: 25 });
    expect(instance.decoding()).toBe("all-frames-fallback");
  });

  it("starts nothing again in thumbnails mode when the full stream is re-encoded, which skips no frames", async () => {
    const instance = start("thumbnails");
    await instance.start("http://e1/play", false);
    await opened(0, MPEG2);
    await runsStarted(2);
    expect(runs[1]).toContain("libx264");
    expect(skipsFrames(runs[1])).toBe(false);
    await opened(1, MPEG2);
    await instance.sync();
    clock.now += 10 * KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await noMoreRuns(2);
    // A re-encoded full stream needs every frame, so the settings want them all: no fallback.
    expect(instance.decoding()).toBe("all-frames");
  });

  it("counts the data that came for runs the controller started again, for a broadcast whose data starts late", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    moves(35);
    await instance.sync();
    await noMoreRuns(1);
    // The controller found no video within its grace period and starts the stream again.
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await runsStarted(2);
    await opened(1);
    live(1);
    await instance.sync();
    moves(9);
    await instance.sync();
    await noMoreRuns(2);
    moves(1);
    await instance.sync();
    await runsStarted(3);
    expect(reasons).toEqual(["start", "restart", "all-frames"]);
    expect(skipsFrames(runs[2])).toBe(false);
  });

  it("counts the data that came for a run that ended before the controller started the stream again", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    moves(35);
    await instance.sync();
    // The controller stops the session first: the run ends, and a sync sees that before the restart.
    exit(children[0]);
    await instance.sync();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await runsStarted(2);
    await opened(1);
    live(1);
    await instance.sync();
    moves(9);
    await instance.sync();
    await noMoreRuns(2);
    moves(1);
    await instance.sync();
    await runsStarted(3);
    expect(reasons).toEqual(["start", "restart", "all-frames"]);
  });

  it("keeps what an earlier run saw when a later run, that saw nothing, ends", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    moves(30);
    await instance.sync();
    // The second run never gets as far as knowing its video.
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await runsStarted(2);
    await instance.sync();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await runsStarted(3);
    await opened(2);
    live(2);
    await instance.sync();
    moves(14);
    await instance.sync();
    await noMoreRuns(3);
    moves(1);
    await instance.sync();
    await runsStarted(4);
    expect(reasons).toEqual(["start", "restart", "restart", "all-frames"]);
  });

  it("starts the wait over for the runs that follow when the data stops coming for a while", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    moves(35);
    await instance.sync();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await runsStarted(2);
    await opened(1);
    live(1);
    await instance.sync();
    // The broadcast sends nothing for a while: what came before counts no more.
    clock.now += 21_000;
    await instance.sync();
    moves(1);
    await instance.sync();
    moves(KEY_FRAMES_PATIENCE_MS / 1000 - 1);
    await instance.sync();
    await noMoreRuns(2);
    moves(1);
    await instance.sync();
    await runsStarted(3);
  });

  it("swaps a handover's run that flowed only a few seconds as soon as the stream is known to need every frame", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    moves(36);
    await instance.start("http://e2/play", true, 0, "http://e2/stat");
    await opened(1);
    live(1);
    await instance.sync();
    moves(7);
    await instance.sync();
    await runsStarted(3);
    expect(reasons).toEqual(["start", "handover", "all-frames"]);
    // The handover's run has seen the data for a few seconds, and that is enough now.
    await instance.sync();
    await runsStarted(4);
    expect(reasons).toEqual(["start", "handover", "all-frames", "all-frames"]);
  });

  it("opens the source again when the run that decodes every frame fails before any video", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    moves(KEY_FRAMES_PATIENCE_MS / 1000);
    await instance.sync();
    await runsStarted(2);
    // The new run follows the session's live edge again.
    expect(edges).toHaveLength(2);
    expect(instance.status().liveEdge).not.toBeNull();

    // It fails before any video, as when the engine is still letting go of the reader it replaces.
    for (const run of [1, 2, 3, 4, 5]) {
      exit(children[run]);
      expect(instance.status()).toMatchObject({ source: "http://e1/play", state: "starting" });
      clock.now += 1000;
      await instance.sync();
      await runsStarted(run + 2);
      expect(skipsFrames(runs[run + 1])).toBe(false);
      expect(reasons.at(-1)).toBe("reopen");
    }
    // Five more tries, as for a standby that becomes the source (see `REOPENS_AFTER_RELEASE`).
    exit(children[6]);
    expect(instance.status().state).toBe("exited");
  });
});
