import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createLogger } from "@aceswarm/shared/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pipeline, type PipelineSettings } from "../src/pipeline.ts";

/** An ffmpeg process that never delivers anything, as with an engine still looking for peers. */
function silentProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  return child;
}

/** How long an ffmpeg run waits for its input, in microseconds. */
function inputTimeout(args: string[] | undefined): string | undefined {
  const index = args?.indexOf("-rw_timeout") ?? -1;
  return index === -1 ? undefined : args?.[index + 1];
}

describe("Pipeline", () => {
  let hlsDir: string;
  let pipeline: Pipeline | undefined;
  /** The arguments of every ffmpeg run, in order. */
  const runs: string[][] = [];
  /** Every ffmpeg process, in the same order. */
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    hlsDir = await mkdtemp(join(tmpdir(), "pipeline-test-"));
    runs.length = 0;
    children.length = 0;
  });

  afterEach(async () => {
    await pipeline?.stop();
    await rm(hlsDir, { recursive: true, force: true });
  });

  function start(handoverTimeoutSeconds: number): Pipeline {
    const settings: PipelineSettings = {
      hlsDir,
      ffmpegPath: "ffmpeg",
      handoverTimeoutMs: handoverTimeoutSeconds * 1000,
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
    };
    const events = { generationStarted: () => undefined, handover: () => undefined };
    pipeline = new Pipeline("s1", settings, createLogger("test", "silent"), events, (_command, args) => {
      runs.push(args);
      const child = silentProcess();
      children.push(child);
      return child;
    });
    return pipeline;
  }

  it("waits the usual input timeout for a source it starts without a handover", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-1/play-again", false);
    expect(runs.map((args) => inputTimeout(args))).toEqual(["60000000", "60000000"]);
  });

  it("waits as long as the handover for a new engine's first data", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(runs[1])).toBe("120000000");
    expect(instance.status().pendingSource).toBe("http://engine-2/play");
  });

  it("waits as long as the handover even when there is no picture left to keep", async () => {
    const instance = start(120);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(runs[0])).toBe("120000000");
    expect(instance.status().source).toBe("http://engine-2/play");
  });

  it("keeps the handover's input timeout when the new source needs re-encoding", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    (children[1]?.stderr as PassThrough).write("  Stream #0:0: Video: hevc (Main), yuv420p, 1920x1080\n");
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    expect(runs[2]).toContain("libx264");
    expect(inputTimeout(runs[2])).toBe("120000000");
    expect(instance.status().pendingSource).toBe("http://engine-2/play");
  });

  it("keeps the usual input timeout when the handover timeout is shorter", async () => {
    const instance = start(30);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(runs[1])).toBe("60000000");
  });
});
