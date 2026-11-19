import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createLogger } from "@aceswarm/shared/logger";
import { createService, type Service } from "@aceswarm/shared/service";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PipelineSettings } from "../src/pipeline.ts";
import { PipelineManager } from "../src/server.ts";
import { fakeSources } from "./fake-source.ts";

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
    // No source is read: nothing comes of one, as with an engine still looking for peers.
    manager = new PipelineManager(service, settings, logger, spawner, undefined, { openSource: fakeSources().open });
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
});
