import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@aceswarm/shared/logger";
import { createService, type Service } from "@aceswarm/shared/service";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PipelineSettings } from "../src/pipeline.ts";
import { PipelineManager } from "../src/server.ts";
import { fakeSources, layoutOf, type FakeSource } from "./fake-source.ts";

const logger = createLogger("test", "silent");

/** An ffmpeg process that runs until the test ends it. */
function fakeFfmpeg(): ChildProcess {
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

describe("the transcoder's metrics", () => {
  let hlsDir: string;
  let service: Service;
  let manager: PipelineManager;
  /** Every ffmpeg process, in order. */
  const children: ChildProcess[] = [];
  /** Every connection to a source, in order. */
  let opened: FakeSource[] = [];

  beforeEach(async () => {
    children.length = 0;
    hlsDir = await mkdtemp(join(tmpdir(), "transcoder-metrics-test-"));
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
    };
    service = createService({ name: "test", logger });
    const spawner = (): ChildProcess => {
      const child = fakeFfmpeg();
      children.push(child);
      return child;
    };
    // No source is read: nothing comes of one, as with an engine still looking for peers, until a test says so.
    const sources = fakeSources();
    opened = sources.opened;
    manager = new PipelineManager(service, settings, logger, spawner, undefined, { openSource: sources.open });
  });

  afterEach(async () => {
    await manager.stopAll();
    await rm(hlsDir, { recursive: true, force: true });
  });

  /** One scrape: what Prometheus gets when it asks once. */
  async function scrape(): Promise<(metric: string, stream: string) => string | undefined> {
    const text = await service.registry.metrics();
    // Every series also has the service's label.
    return (metric, stream) =>
      new RegExp(String.raw`^${metric}\{stream="${stream}"[^}]*\} (\S+)$`, "m").exec(text)?.[1];
  }

  /** Each series of a metric of the first stream, in one scrape: the values of its `labels`, and its value. */
  async function seriesOf(metric: string, ...labels: string[]): Promise<Record<string, string>> {
    const text = await service.registry.metrics();
    const found: Record<string, string> = {};
    const series = text.matchAll(new RegExp(String.raw`^${metric}\{([^}]*)\} (\S+)$`, "gm"));
    for (const [, all = "", value = ""] of series) {
      const values = labels.map((label) => new RegExp(`(?:^|,)${label}="([^"]*)"`).exec(all)?.[1] ?? "");
      if (all.includes('stream="s1"')) {
        found[values.join(" ")] = value;
      }
    }
    return found;
  }

  /** Each series of how the first stream's ffmpeg decodes, in one scrape: its `decoding` label and value. */
  const decodings = (): Promise<Record<string, string>> => seriesOf("aceswarm_pipeline_decoding", "decoding");

  async function progress(run: number, block: string): Promise<void> {
    (children[run]?.stdout as PassThrough).write(block);
    await nextTurn();
  }

  test("a stream has a frame rate only while its ffmpeg runs, so a stopped one leaves a gap", async () => {
    await manager.start("s1", "http://e1/play", false);
    await manager.start("s2", "http://e2/play", false);
    expect((await scrape())("aceswarm_pipeline_fps", "s1")).toBeUndefined();

    // Both start on a buffered window, which ffmpeg reads much faster than real time.
    await progress(0, "frame=5700\nfps=1140.93\nprogress=continue\n");
    await progress(1, "frame=4370\nfps=873.95\nprogress=continue\n");
    // Each step is checked on the one scrape that follows it: a gauge that showed what the scrape
    // before it collected would be a step behind here.
    const running = await scrape();
    expect(running("aceswarm_pipeline_fps", "s1")).toBe("1140.93");
    expect(running("aceswarm_pipeline_running", "s1")).toBe("1");
    expect(running("aceswarm_pipeline_fps", "s2")).toBe("873.95");

    // The first one's ffmpeg ends: its last value must not stay as a flat line.
    Object.assign(children[0] ?? {}, { exitCode: 255 });
    children[0]?.emit("exit", 255, null);
    const ended = await scrape();
    expect(ended("aceswarm_pipeline_fps", "s1")).toBeUndefined();
    expect(ended("aceswarm_pipeline_running", "s1")).toBe("0");
    // The other stream's goes on.
    expect(ended("aceswarm_pipeline_fps", "s2")).toBe("873.95");
    expect(ended("aceswarm_pipeline_running", "s2")).toBe("1");

    // A new run of the first one reports its own.
    await manager.start("s1", "http://e1/play", false);
    expect((await scrape())("aceswarm_pipeline_fps", "s1")).toBeUndefined();
    await progress(2, "frame=50\nfps=25\nprogress=continue\n");
    expect((await scrape())("aceswarm_pipeline_fps", "s1")).toBe("25");
  });

  test("says how each stream's ffmpeg decodes, with one series per way and 1 for the current one", async () => {
    expect(await decodings()).toEqual({});
    await manager.start("s1", "http://e1/play", false);
    // Video mode decodes every frame, as the settings want.
    expect(await decodings()).toEqual({
      "key-frames": "0",
      "key-frames-waiting": "0",
      "all-frames-fallback": "0",
      "all-frames": "1",
    });

    // The gauge follows the pipeline at each scrape (the pipeline's tests check its states).
    const pipeline = manager.get("s1");
    expect(pipeline).toBeDefined();
    if (pipeline === undefined) {
      return;
    }
    const decoding = vi.spyOn(pipeline, "decoding").mockReturnValue("key-frames-waiting");
    expect(await decodings()).toMatchObject({ "key-frames-waiting": "1", "all-frames": "0" });
    decoding.mockReturnValue("all-frames-fallback");
    expect(await decodings()).toMatchObject({ "key-frames-waiting": "0", "all-frames-fallback": "1" });
    decoding.mockReturnValue(undefined);
    expect(await decodings()).toEqual({});

    // A stream whose pipeline is removed has none.
    decoding.mockRestore();
    expect(await decodings()).toMatchObject({ "all-frames": "1" });
    await manager.stop("s1");
    expect(await decodings()).toEqual({});
  });

  test("says what each stream's full output does with the video, and the codec its source carries", async () => {
    expect(await seriesOf("aceswarm_pipeline_full_mode", "mode")).toEqual({});
    await manager.start("s1", "http://e1/play", false);
    // Neither the tables nor ffmpeg told of the video yet.
    expect(await seriesOf("aceswarm_pipeline_full_mode", "mode")).toEqual({ copy: "1", transcode: "0" });
    expect(await seriesOf("aceswarm_pipeline_video_codec", "codec")).toEqual({});
    opened[0]?.layout(layoutOf(256));
    expect(await seriesOf("aceswarm_pipeline_video_codec", "codec")).toEqual({ h264: "1" });

    // The broadcast changes to HEVC: only the codec it carries now has a series.
    opened[0]?.layout(layoutOf(211, 0x24));
    expect(await seriesOf("aceswarm_pipeline_full_mode", "mode")).toEqual({ copy: "0", transcode: "1" });
    expect(await seriesOf("aceswarm_pipeline_video_codec", "codec")).toEqual({ hevc: "1" });

    await manager.stop("s1");
    expect(await seriesOf("aceswarm_pipeline_full_mode", "mode")).toEqual({});
    expect(await seriesOf("aceswarm_pipeline_video_codec", "codec")).toEqual({});
  });

  test("counts the layout changes ffmpeg follows, by kind and by run, from zero", async () => {
    await manager.start("s1", "http://e1/play", false);
    opened[0]?.layout(layoutOf(256));
    // Every series is there from the start, so that Prometheus sees the first change as an increase.
    const none = {
      "codec new": "0",
      "codec same": "0",
      "pid new": "0",
      "pid same": "0",
      "other new": "0",
      "other same": "0",
    };
    expect(await seriesOf("aceswarm_pipeline_layout_changes_total", "kind", "run")).toEqual(none);
    opened[0]?.layout(layoutOf(211, 0x24));
    opened[0]?.move(layoutOf(311, 0x24));
    opened[0]?.layout(layoutOf(411, 0x24));
    expect(await seriesOf("aceswarm_pipeline_layout_changes_total", "kind", "run")).toEqual({
      ...none,
      "codec new": "1",
      "pid same": "1",
      "pid new": "1",
    });
  });

  test("says how long players waited for video at each layout change, from zero", async () => {
    await manager.start("s1", "http://e1/play", false);
    opened[0]?.layout(layoutOf(256));
    const waits = (): Promise<Record<string, string>> => seriesOf("aceswarm_pipeline_layout_change_gap_seconds_count");
    expect(await waits()).toEqual({ "": "0" });
    // The run plays: players got a frame.
    const directory = join(hlsDir, "s1", "g1", "full");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,\nseg_000000.ts\n");
    await progress(0, "frame=50\nfps=25\nprogress=continue\n");
    await manager.get("s1")?.sync();
    // The broadcast moves its streams, and the same run reads on: its next frame ends the wait.
    opened[0]?.move(layoutOf(211));
    await sleep(20);
    await progress(0, "frame=60\nfps=25\nprogress=continue\n");
    expect(await waits()).toEqual({ "": "1" });
    const waited = Number((await seriesOf("aceswarm_pipeline_layout_change_gap_seconds_sum"))[""]);
    expect(waited).toBeGreaterThanOrEqual(0.02);
    expect(waited).toBeLessThan(5);
  });
});
