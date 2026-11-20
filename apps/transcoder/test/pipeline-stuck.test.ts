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

const H264 = "  Stream #0:0[0x100]: Video: h264 (High), yuv420p(progressive), 1920x1080, 25 fps\n";
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

/** How a run makes the full output's video: the first `-c:v` is that output's. */
function fullCodec(args: string[] | undefined): string | undefined {
  return args?.[args.indexOf("-c:v") + 1];
}

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

  function start(): Pipeline {
    const settings: PipelineSettings = {
      hlsDir,
      ffmpegPath: "ffmpeg",
      handoverTimeoutMs: 120_000,
      plan: {
        previewMode: "video",
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
      stuck: { fullOutputStallMs: 30_000, maxMemoryBytes: 1024 * MB },
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
        const sent: string[] = [];
        signals.push(sent);
        const child = fakeFfmpeg(1000 + children.length, sent);
        children.push(child);
        return child;
      },
      now: () => clock.now,
      memoryOf: (pid) => memory.get(pid) ?? 80 * MB,
    });
    return pipeline;
  }

  /** ffmpeg of the run writes a file of its generation now, by the test's clock. */
  async function wrote(file: string, run = 0): Promise<void> {
    const path = join(hlsDir, "s1", `g${String(run + 1)}`, file);
    await writeFile(path, "#EXTM3U\n");
    await utimes(path, clock.now / 1000, clock.now / 1000);
  }

  /** A second of the run: its preview writes, and its full output too unless it stalled. */
  async function second(run: number, full: boolean, frame: number): Promise<void> {
    clock.now += 1000;
    (children[run]?.stdout as PassThrough).write(`frame=${String(frame)}\nfps=25\nprogress=continue\n`);
    await nextTurn();
    await wrote("preview/index.m3u8", run);
    if (full) {
      await wrote("full/index.m3u8", run);
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
    expect(instance.status().source).toBe("http://engine-1/play");

    // The new run plays: it is left alone.
    for (let at = 1; at <= 40; at += 1) {
      await second(1, true, at * 25);
    }
    expect(runs).toHaveLength(2);
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

    // It plays, and the stream's later runs re-encode too, as for a source that is not H.264.
    for (let at = 1; at <= 40; at += 1) {
      await second(2, true, at * 25);
    }
    expect(runs).toHaveLength(3);
    await instance.start("http://engine-2/play", false);
    expect(fullCodec(runs[3])).toBe("libx264");
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

  it("starts ffmpeg again once it holds more than the memory limit", async () => {
    const instance = start();
    await instance.start("http://engine-1/play", false);
    (children[0]?.stderr as PassThrough).write(H264);
    for (let at = 1; at <= 5; at += 1) {
      await second(0, true, at * 25);
    }
    memory.set(1000, 1500 * MB);
    await second(0, true, 6 * 25);
    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    expect(reasons).toEqual(["start", "memory"]);
    expect(signals[0]?.[0]).toBe("SIGKILL");
    expect(warn).toHaveBeenCalledWith(
      { generation: 1, memoryMb: 1500, limitMb: 1024 },
      "ffmpeg holds too much memory; starting it again",
    );
  });
});
