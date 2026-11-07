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
    killed: false,
    kill: () => {
      Object.assign(child, { killed: true });
      return true;
    },
  });
  return child;
}

/** An ffmpeg run that ends, as when the engine refuses the connection. */
function exit(child: ChildProcess | undefined, code = 183): void {
  Object.assign(child ?? {}, { exitCode: code });
  (child?.stderr as PassThrough | undefined)?.write(
    "Error opening input files: Invalid data found when processing input\n",
  );
  child?.emit("exit", code, null);
}

/** The source an ffmpeg run reads. */
function sourceOf(args: string[] | undefined): string | undefined {
  const index = args?.indexOf("-i") ?? -1;
  return index === -1 ? undefined : args?.[index + 1];
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

  function start(handoverTimeoutSeconds: number, now: () => number = Date.now): Pipeline {
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
    const logger = createLogger("test", "silent");
    pipeline = new Pipeline(
      "s1",
      settings,
      logger,
      events,
      (_command, args) => {
        runs.push(args);
        const child = silentProcess();
        children.push(child);
        return child;
      },
      now,
    );
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

  it("opens a handover's source again when ffmpeg fails before any video, as often as asked", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false);
    // The engine has just lost the standby's reader of this session, and refuses ffmpeg at first.
    await instance.start("http://engine-2/play", true, 2);
    exit(children[1]);
    await instance.sync();
    expect(runs).toHaveLength(2);
    expect(instance.status().pendingSource).toBe("http://engine-2/play");

    for (const run of [2, 3]) {
      clock.now += 1000;
      await instance.sync();
      await vi.waitFor(() => {
        expect(runs).toHaveLength(run + 1);
      });
      expect(sourceOf(runs[run])).toBe("http://engine-2/play");
      expect(inputTimeout(runs[run])).toBe("120000000");
      expect(instance.status().pendingSource).toBe("http://engine-2/play");
      exit(children[run]);
    }

    clock.now += 1000;
    await instance.sync();
    expect(runs).toHaveLength(4);
    expect(instance.status()).toMatchObject({ source: "http://engine-1/play", pendingSource: null });
  });

  it("gives up on a handover at once when ffmpeg fails and no reopen was asked", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    exit(children[1]);
    await instance.sync();
    expect(instance.status().pendingSource).toBeNull();
    expect(runs).toHaveLength(2);
  });

  it("does not open the source again once ffmpeg delivered video from it", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true, 2);
    (children[1]?.stdout as PassThrough).write("frame=12\nfps=25\nprogress=continue\n");
    await new Promise((resolve) => setImmediate(resolve));
    exit(children[1], 1);
    clock.now += 1000;
    await instance.sync();
    expect(runs).toHaveLength(2);
    expect(instance.status().pendingSource).toBeNull();
  });

  it("says a restart that failed before any video is still starting until ffmpeg opens it again", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false);
    exit(children[0], 1);
    // No picture is left to keep, so the new source starts at once instead of a handover.
    await instance.start("http://engine-2/play", true, 1);
    exit(children[1]);
    expect(instance.status()).toMatchObject({ source: "http://engine-2/play", state: "starting" });

    clock.now += 1000;
    await instance.sync();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    expect(sourceOf(runs[2])).toBe("http://engine-2/play");
    exit(children[2]);
    expect(instance.status()).toMatchObject({ source: "http://engine-2/play", state: "exited" });
  });

  it("leaves one ffmpeg running when a sync opens a source again while a restart starts", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false, 2);
    exit(children[0]);
    clock.now += 1000;
    await Promise.all([instance.start("http://engine-2/play", false), instance.sync()]);
    // The sync's run of the old source creates its directories before it would start ffmpeg.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const running = children.filter((child) => child.exitCode === null && !child.killed);
    expect(running.map((child) => sourceOf(runs[children.indexOf(child)]))).toEqual(["http://engine-2/play"]);
    expect(instance.status().source).toBe("http://engine-2/play");
  });

  it("gives up on a handover whose source keeps failing once the handover timeout passed", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true, 5);
    exit(children[1]);
    clock.now += 60_000;
    await instance.sync();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    exit(children[2]);
    // The reopened run started a minute later, but the handover began two minutes ago.
    clock.now += 61_000;
    await instance.sync();
    expect(runs).toHaveLength(3);
    expect(instance.status().pendingSource).toBeNull();
  });
});
