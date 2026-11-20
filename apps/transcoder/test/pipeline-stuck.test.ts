import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createLogger } from "@aceswarm/shared/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pipeline, type PipelineSettings } from "../src/pipeline.ts";
import { fakeSources, layoutOf, type FakeSource } from "./fake-source.ts";

const H264 = "  Stream #0:0[0x100]: Video: h264 (High), yuv420p(progressive), 1920x1080, 25 fps\n";
const HEVC = "  Stream #0:0[0x100]: Video: hevc (Main), yuv420p(tv), 1920x1080, 25 fps\n";
const MB = 1024 * 1024;

/** An ffmpeg process that runs until the test ends it, and notes how it was stopped. */
function fakeFfmpeg(pid: number, signals: string[]): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: (signal: string) => {
      signals.push(signal);
      Object.assign(child, { killed: true });
      return true;
    },
  });
  return child;
}

/** It fails before any video, as when the engine still lets go of the reader it replaces. */
function exit(child: ChildProcess | undefined): void {
  Object.assign(child ?? {}, { exitCode: 183 });
  child?.emit("exit", 183, null);
}

/** How a run makes the full output's video: the first `-c:v` is that output's. */
function fullCodec(args: string[] | undefined): string | undefined {
  return args?.[args.indexOf("-c:v") + 1];
}

/** The full output's playlist of a run once it wrote `count` segments: players get them. */
const fullPlaylist = (count: number): string =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${Array.from({ length: count }, (_, index) => `#EXTINF:2.0,\nseg_${String(index)}.ts\n`).join("")}`;

describe("Pipeline with a run that goes on but is stuck", () => {
  let hlsDir: string;
  let pipeline: Pipeline | undefined;
  const runs: string[][] = [];
  const children: ChildProcess[] = [];
  /** The signals each run was sent, by run. */
  const signals: string[][] = [];
  const reasons: string[] = [];
  const clock = { now: 1_800_000_000_000 };
  const memory = new Map<number, number>();
  const streamLogger = createLogger("test", "silent");
  let warn = vi.spyOn(streamLogger, "warn");
  /** The source each run opened, in the same order. */
  let readers: FakeSource[] = [];

  beforeEach(async () => {
    hlsDir = await mkdtemp(join(tmpdir(), "pipeline-stuck-test-"));
    runs.length = 0;
    children.length = 0;
    signals.length = 0;
    reasons.length = 0;
    memory.clear();
    clock.now = 1_800_000_000_000;
    warn = vi.spyOn(streamLogger, "warn");
  });

  afterEach(async () => {
    await pipeline?.stop();
    await rm(hlsDir, { recursive: true, force: true });
  });

  function start(previewMode: PipelineSettings["plan"]["previewMode"] = "video"): Pipeline {
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
      stuck: { fullOutputStallMs: 30_000, maxMemoryGrowthBytes: 512 * MB },
    };
    const events = {
      generationStarted: (_id: string, reason: string) => {
        reasons.push(reason);
      },
      handover: () => undefined,
    };
    const sources = fakeSources();
    readers = sources.opened;
    const logger = createLogger("test", "silent");
    vi.spyOn(logger, "child").mockReturnValue(streamLogger as never);
    pipeline = new Pipeline("s1", settings, logger, events, {
      spawner: (_command, args) => {
        runs.push(args);
        const sent: string[] = [];
        signals.push(sent);
        const child = fakeFfmpeg(1000 + children.length, sent);
        children.push(child);
        return child;
      },
      now: () => clock.now,
      memoryOf: (pid) => memory.get(pid) ?? 80 * MB,
      openSource: sources.open,
    });
    return pipeline;
  }

  /** ffmpeg of the run writes a file of its generation now, by the test's clock. */
  async function wrote(file: string, run = 0, text = "#EXTM3U\n"): Promise<void> {
    const path = join(hlsDir, "s1", `g${String(run + 1)}`, file);
    await writeFile(path, text);
    await utimes(path, clock.now / 1000, clock.now / 1000);
  }

  /**
   * A second of the run: its preview writes (unless `preview` is false), and its full output too
   * unless it stalled.
   */
  async function second(run: number, full: boolean, frame: number, preview = true): Promise<void> {
    clock.now += 1000;
    (children[run]?.stdout as PassThrough).write(`frame=${String(frame)}\nfps=25\nprogress=continue\n`);
    await nextTurn();
    if (preview) {
      await wrote("preview/index.m3u8", run);
    }
    if (full) {
      await wrote("full/index.m3u8", run, fullPlaylist(Math.floor(frame / 50)));
    }
    await pipeline?.sync();
  }

  it("starts ffmpeg again on the same source once its full output wrote nothing for 30 s", async () => {
    const instance = start();
    await instance.start("http://engine-1/play", false);
    (children[0]?.stderr as PassThrough).write(H264);
    for (let at = 1; at <= 20; at += 1) {
      await second(0, true, at * 25);
    }
    // The broadcast stops sending key frames: the preview and the frame count go on.
    for (let at = 21; at < 50; at += 1) {
      await second(0, false, at * 25);
    }
    expect(runs).toHaveLength(1);
    await second(0, false, 50 * 25);
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    expect(reasons).toEqual(["start", "full-output-stalled"]);
    expect(runs[1]).toEqual(runs[0]?.map((arg) => arg.replace("/g1/", "/g2/")));
    // Killed outright: as it stops, ffmpeg would write out the whole segment it holds.
    expect(signals[0]?.[0]).toBe("SIGKILL");
    expect(warn).toHaveBeenCalledWith(
      { generation: 1, seconds: 30, frames: 1250 },
      "the full output wrote no segment while ffmpeg still made video; starting it again",
    );
    // Until the new run has video, the stream's last frame is the old run's, and the controller is
    // told when the transcoder started it.
    const restartedAt = new Date(clock.now).toISOString();
    expect(instance.status()).toMatchObject({
      source: "http://engine-1/play",
      state: "starting",
      lastFrameAt: new Date(clock.now).toISOString(),
      restartedAt,
    });

    // The new run plays: it is left alone.
    for (let at = 1; at <= 40; at += 1) {
      await second(1, true, at * 25);
    }
    expect(runs).toHaveLength(2);
    expect(instance.status()).toMatchObject({ lastFrameAt: new Date(clock.now).toISOString(), restartedAt });
  });

  it("opens the source again when the run that replaced a stuck one fails before any video", async () => {
    const instance = start();
    await instance.start("http://engine-1/play", false);
    (children[0]?.stderr as PassThrough).write(H264);
    for (let at = 1; at <= 10; at += 1) {
      await second(0, true, at * 25);
    }
    for (let at = 11; at <= 40; at += 1) {
      await second(0, false, at * 25);
    }
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    exit(children[1]);
    clock.now += 1000;
    await instance.sync();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    expect(reasons).toEqual(["start", "full-output-stalled", "reopen"]);
    // The stream's last frame is still the stalled run's: the controller still waits for the new one.
    const { lastFrameAt, restartedAt } = instance.status();
    expect(lastFrameAt).not.toBeNull();
    expect(Date.parse(restartedAt ?? "") - Date.parse(lastFrameAt ?? "")).toBeLessThanOrEqual(1000);
  });

  it("re-encodes the full stream when the copy that replaced a stalled one gets no segment either", async () => {
    const instance = start();
    await instance.start("http://engine-1/play", false);
    (children[0]?.stderr as PassThrough).write(H264);
    for (let at = 1; at <= 10; at += 1) {
      await second(0, true, at * 25);
    }
    for (let at = 11; at <= 40; at += 1) {
      await second(0, false, at * 25);
    }
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    // The broadcast still sends no key frame: ffmpeg drops the copied video's frames before the
    // first one, so the full output gets nothing and ffmpeg counts no frame, but the preview goes on.
    (children[1]?.stderr as PassThrough).write(H264);
    for (let at = 1; at <= 30; at += 1) {
      await second(1, false, 0);
    }
    expect(runs).toHaveLength(2);
    await second(1, false, 0);
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    expect(reasons).toEqual(["start", "full-output-stalled", "full-output-stalled"]);
    expect(runs.map((args) => fullCodec(args))).toEqual(["copy", "copy", "libx264"]);
    expect(instance.status().mode).toBe("transcode");
    expect(signals[1]?.[0]).toBe("SIGKILL");
    expect(warn).toHaveBeenCalledWith(
      { generation: 2, seconds: 30, frames: 0 },
      "the full output wrote no segment again after a restart: the copied video has no key frames to cut it at; re-encoding it",
    );

    // The source's tables and ffmpeg both say the video is H.264: the run re-encodes it all the same.
    expect(readers[2]?.layout(layoutOf(256))).toBe(false);
    (children[2]?.stderr as PassThrough).write(H264);
    await nextTurn();
    expect(runs).toHaveLength(3);
    // It plays, and the stream's later runs re-encode too: a run started again for its memory, and
    // one on another source.
    for (let at = 1; at <= 70; at += 1) {
      await second(2, true, at * 25);
    }
    expect(runs).toHaveLength(3);
    memory.set(1002, 2000 * MB);
    await second(2, true, 71 * 25);
    await vi.waitFor(() => {
      expect(runs).toHaveLength(4);
    });
    expect(reasons.at(-1)).toBe("memory");
    expect(fullCodec(runs[3])).toBe("libx264");
    await instance.start("http://engine-2/play", false);
    expect(fullCodec(runs[4])).toBe("libx264");
  });

  it("decodes every frame after a stall with key frames only decoding, so the next run shows whether its copy gets any", async () => {
    const instance = start("keyframes");
    await instance.start("http://engine-1/play", false);
    (children[0]?.stderr as PassThrough).write(H264);
    expect(runs[0]).toContain("-skip_frame");
    for (let at = 1; at <= 10; at += 1) {
      await second(0, true, at * 25);
    }
    // The key frames stop: so do the full output and the preview, which decodes key frames only.
    for (let at = 11; at <= 40; at += 1) {
      await second(0, false, at * 25, false);
    }
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    expect(reasons).toEqual(["start", "full-output-stalled"]);
    expect(runs[1]).not.toContain("-skip_frame");
    expect(instance.decoding()).toBe("all-frames-fallback");
    // Its preview goes on and its copy gets nothing: the full stream is re-encoded, from every frame.
    (children[1]?.stderr as PassThrough).write(H264);
    for (let at = 1; at <= 31; at += 1) {
      await second(1, false, 0);
    }
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    expect(fullCodec(runs[2])).toBe("libx264");
    expect(runs[2]).not.toContain("-skip_frame");
  });

  it("keeps the stream's last frame when the run started again finds that the video is not H.264", async () => {
    const instance = start();
    await instance.start("http://engine-1/play", false);
    (children[0]?.stderr as PassThrough).write(H264);
    for (let at = 1; at <= 10; at += 1) {
      await second(0, true, at * 25);
    }
    for (let at = 11; at <= 40; at += 1) {
      await second(0, false, at * 25);
    }
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    const { lastFrameAt, restartedAt } = instance.status();
    expect(lastFrameAt).not.toBeNull();
    // The broadcast moved on to HEVC: the run is replaced by one that re-encodes it, which the
    // controller waits for as well.
    (children[1]?.stderr as PassThrough).write(HEVC);
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    expect(fullCodec(runs[2])).toBe("libx264");
    await vi.waitFor(() => {
      expect(instance.status()).toMatchObject({ mode: "transcode", lastFrameAt, restartedAt });
    });
  });

  it("leaves a run alone whose source stopped: nothing makes video, and the controller deals with it", async () => {
    const instance = start();
    await instance.start("http://engine-1/play", false);
    (children[0]?.stderr as PassThrough).write(H264);
    for (let at = 1; at <= 10; at += 1) {
      await second(0, true, at * 25);
    }
    for (let at = 0; at < 120; at += 1) {
      clock.now += 1000;
      await instance.sync();
    }
    expect(runs).toHaveLength(1);
  });

  it("starts ffmpeg again once its memory grew by more than the limit over what it settled at", async () => {
    const instance = start();
    await instance.start("http://engine-1/play", false);
    (children[0]?.stderr as PassThrough).write(H264);
    // A run that holds over a GB from the start is fine (a re-encode on a host with many cores).
    memory.set(1000, 1100 * MB);
    for (let at = 1; at <= 70; at += 1) {
      await second(0, true, at * 25);
    }
    expect(runs).toHaveLength(1);
    memory.set(1000, 1700 * MB);
    await second(0, true, 71 * 25);
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    expect(reasons).toEqual(["start", "memory"]);
    expect(signals[0]?.[0]).toBe("SIGKILL");
    expect(warn).toHaveBeenCalledWith(
      { generation: 1, memoryMb: 1700, settledMb: 1100, limitMb: 512 },
      "ffmpeg's memory keeps growing; starting it again",
    );
    expect(fullCodec(runs[1])).toBe("copy");
  });
});
