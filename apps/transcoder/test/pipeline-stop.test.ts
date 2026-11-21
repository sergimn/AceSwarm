import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createLogger } from "@aceswarm/shared/logger";
import { createService } from "@aceswarm/shared/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pipeline, type PipelineOptions, type PipelineSettings } from "../src/pipeline.ts";
import { PipelineManager } from "../src/server.ts";
import { fakeSources, layoutOf, type FakeSource } from "./fake-source.ts";

/**
 * How removing files goes in these tests: paths whose removal fails, as when ffmpeg keeps writing
 * into a directory that is going, and paths whose removal takes a while, as when it has to try
 * again. `order` tells what happened when: a slow path removed, an ffmpeg started.
 */
const removal = vi.hoisted(() => ({ stuck: new Set<string>(), slow: new Set<string>(), order: [] as string[] }));

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof FsPromises>();
  const rmAsTold: typeof real.rm = async (path, options) => {
    const target = String(path);
    if (removal.stuck.has(target)) {
      throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${target}'`), { code: "ENOTEMPTY" });
    }
    if (removal.slow.has(target)) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await real.rm(path, options);
    if (removal.slow.has(target)) {
      removal.order.push("removed");
    }
  };
  return { ...real, rm: rmAsTold };
});

const events = { generationStarted: () => undefined, handover: () => undefined };

/** An ffmpeg process that takes its input and says nothing. */
function quietProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  stdin.resume();
  Object.assign(child, {
    pid: 4242,
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => true,
  });
  return child;
}

/** A playlist as a run leaves it after about half an hour of play. */
const OLD_PLAYLIST = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:900\n#EXTINF:2.0,\nseg_000900.ts\n";

describe("stopping a stream, and starting it again", () => {
  let hlsDir: string;
  let settings: PipelineSettings;
  let opened: FakeSource[] = [];
  const logger = createLogger("test", "silent");
  const streamLogger = createLogger("test", "silent");
  const options = (): PipelineOptions => {
    const sources = fakeSources();
    opened = sources.opened;
    return { spawner: () => quietProcess(), openSource: sources.open };
  };
  /** Leaves an old run's playlist and segment in a run's directory of the stream. */
  const leave = async (run: string): Promise<string> => {
    const directory = join(hlsDir, "stream1", run, "full");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "seg_000900.ts"), "old");
    await writeFile(join(directory, "index.m3u8"), OLD_PLAYLIST);
    return directory;
  };

  beforeEach(async () => {
    hlsDir = await mkdtemp(join(tmpdir(), "pipeline-stop-test-"));
    removal.stuck.clear();
    removal.slow.clear();
    removal.order.length = 0;
    vi.spyOn(logger, "child").mockReturnValue(streamLogger as never);
    settings = {
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
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    removal.stuck.clear();
    await rm(hlsDir, { recursive: true, force: true });
  });

  it("stops though some of the stream's files can't be removed, and says so", async () => {
    const warn = vi.spyOn(streamLogger, "warn");
    const pipeline = new Pipeline("stream1", settings, logger, events, options());
    await pipeline.start("http://engine/play", false);
    removal.stuck.add(join(hlsDir, "stream1"));

    await expect(pipeline.stop()).resolves.toBeUndefined();

    expect(opened[0]?.stopped).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ code: "ENOTEMPTY" }) as unknown },
      "could not remove all of the stream's files",
    );
  });

  it("starts a run on an empty directory, whatever an earlier pipeline of the stream left there", async () => {
    const left = await leave("g1");
    const pipeline = new Pipeline("stream1", settings, logger, events, options());

    await pipeline.start("http://engine/play", false);
    await pipeline.sync();

    expect(existsSync(left)).toBe(true);
    expect(existsSync(join(left, "index.m3u8"))).toBe(false);
    expect(existsSync(join(left, "seg_000900.ts"))).toBe(false);
    expect((await pipeline.playlist("full")) ?? "").not.toContain("seg_000900");
    await pipeline.stop();
  });

  it("starts the run that takes over at a layout change on an empty directory too", async () => {
    const left = await leave("g2");
    const pipeline = new Pipeline("stream1", settings, logger, events, options());
    await pipeline.start("http://engine/play", false);
    opened[0]?.layout(layoutOf(256));

    // The video moves to another codec: a second run takes over, in the stream's second directory.
    expect(opened[0]?.layout(layoutOf(211, 0x24))).toBe(true);

    expect(existsSync(left)).toBe(true);
    expect(existsSync(join(left, "index.m3u8"))).toBe(false);
    expect(existsSync(join(left, "seg_000900.ts"))).toBe(false);
    await pipeline.stop();
  });

  it("starts a stream again only once its last pipeline has removed its files", async () => {
    const spawner = (): ChildProcess => {
      removal.order.push("ffmpeg started");
      return quietProcess();
    };
    const manager = new PipelineManager(createService({ name: "test", logger }), settings, logger, spawner, undefined, {
      openSource: fakeSources().open,
    });
    await manager.start("stream1", "http://engine/play", false);
    // The removal takes a while, as when it has to try again for files ffmpeg wrote as it died.
    removal.slow.add(join(hlsDir, "stream1"));
    const stopped = manager.stop("stream1");

    // The controller starts the stream again while the old pipeline still stops.
    await manager.start("stream1", "http://engine/play", false);

    expect(removal.order).toEqual(["ffmpeg started", "removed", "ffmpeg started"]);
    expect(await stopped).toBe(true);
    // The new run's directory was made after the old pipeline removed everything: it is still there.
    expect(existsSync(join(hlsDir, "stream1", "g1", "full"))).toBe(true);
    removal.slow.clear();
    await manager.stopAll();
  });
});
