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
import { KEY_FRAMES_PATIENCE_MS, Pipeline, type PipelineSettings } from "../src/pipeline.ts";

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

  beforeEach(async () => {
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

  function start(previewMode: "video" | "keyframes" = "keyframes"): Pipeline {
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
    pipeline = new Pipeline("s1", settings, createLogger("test", "silent"), events, {
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

  /** The session's live edge of the first run moves a second each second, and it downloads. */
  function live(): void {
    for (let step = 0; step <= 3; step += 1) {
      clock.now += step === 0 ? 0 : 1000;
      edges[0]?.edge.observe({ status: "dl", downloaded: 100 + step * 100, last: 5000 + step, pos: 5000 + step });
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
    await instance.start("http://e1/play", false);
    expect(skipsFrames(runs[0])).toBe(true);
    expect(previewFilter(runs[0])).toBe("scale=-2:270");
    await opened();
    await instance.sync();

    // Keyframes mode may take a while to show a first frame from a broadcast whose key frames
    // come every few seconds.
    clock.now += KEY_FRAMES_PATIENCE_MS - 1000;
    await instance.sync();
    await noMoreRuns(1);

    clock.now += 1000;
    await instance.sync();
    await runsStarted(2);
    expect(children[0]?.killed).toBe(true);
    expect(skipsFrames(runs[1])).toBe(false);
    // With every frame decoded, the preview thins them out as in video mode.
    expect(previewFilter(runs[1])).toBe("fps=15,scale=-2:270");
    expect(reasons).toEqual(["start", "all-frames"]);
    expect(instance.status()).toMatchObject({ source: "http://e1/play", state: "starting", frames: 0 });

    // The new run counts: it is the same source, and a new one gets the same treatment.
    await opened(1);
    await frames(25, 1);
    expect(instance.status()).toMatchObject({ state: "running", frames: 25 });
    await instance.start("http://e2/play", false);
    expect(skipsFrames(runs[2])).toBe(false);
    expect(reasons).toEqual(["start", "all-frames", "restart"]);
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
    await frames(1);
    await instance.sync();
    clock.now += 60_000;
    await instance.sync();
    await noMoreRuns(1);
    expect(instance.status().state).toBe("running");
    await instance.start("http://e2/play", false);
    expect(skipsFrames(runs[1])).toBe(true);
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
    clock.now += KEY_FRAMES_PATIENCE_MS - 1000;
    edges[0]?.edge.observe({ status: "dl", downloaded: 900, last: 5003 + 19, pos: 5003 + 19 });
    await instance.sync();
    await noMoreRuns(1);
    clock.now += 1000;
    edges[0]?.edge.observe({ status: "dl", downloaded: 1000, last: 5003 + 20, pos: 5003 + 20 });
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

  it("decodes every frame of a handover's source, and the handover goes on with that run", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await frames(50);
    await instance.start("http://e2/play", true);
    expect(instance.status().pendingSource).toBe("http://e2/play");
    await opened(1);
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS;
    await instance.sync();
    await runsStarted(3);
    expect(children[1]?.killed).toBe(true);
    expect(children[0]?.killed).toBe(false);
    expect(skipsFrames(runs[2])).toBe(false);
    expect(reasons).toEqual(["start", "handover", "all-frames"]);
    // The source it plays from keeps its key frames only decoding: it is running fine.
    expect(instance.status()).toMatchObject({ source: "http://e1/play", pendingSource: "http://e2/play" });
  });

  it("gives up on a handover that timed out instead of starting it again", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await opened();
    await frames(50);
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
  });

  it("opens the source again when the run that decodes every frame fails before any video", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    await opened();
    live();
    await instance.sync();
    clock.now += KEY_FRAMES_PATIENCE_MS;
    edges[0]?.edge.observe({ status: "dl", downloaded: 900, last: 5003 + 20, pos: 5003 + 20 });
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
