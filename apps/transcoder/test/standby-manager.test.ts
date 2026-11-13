import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createLogger } from "@aceswarm/shared/logger";
import { createService } from "@aceswarm/shared/service";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PipelineSettings } from "../src/pipeline.ts";
import { PipelineManager } from "../src/server.ts";

const logger = createLogger("test", "silent");

/** An ffmpeg process that never delivers anything. */
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

describe("standby readers of a stream", () => {
  let hlsDir: string;
  let manager: PipelineManager;
  /** Every ffmpeg process, in order. */
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    children.length = 0;
    hlsDir = await mkdtemp(join(tmpdir(), "standby-manager-test-"));
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
    // The readers' engines don't exist: they wait a minute before connecting again.
    const spawner = (): ChildProcess => {
      const child = silentProcess();
      children.push(child);
      return child;
    };
    manager = new PipelineManager(createService({ name: "test", logger }), settings, logger, spawner, {
      idleTimeoutMs: 60_000,
      retryMs: 60_000,
    });
  });

  afterEach(async () => {
    await manager.stopAll();
    await rm(hlsDir, { recursive: true, force: true });
  });

  test("reads standbys only while the stream has a pipeline, and never the source ffmpeg reads", async () => {
    expect(manager.setStandbys("s1", ["http://e2/play"])).toBeUndefined();
    await manager.start("s1", "http://e1/play", false);
    const sources = manager.setStandbys("s1", ["http://e1/play", "http://e2/play"])?.map(({ source }) => source);
    expect(sources).toEqual(["http://e2/play"]);

    // A failover: ffmpeg takes the standby's source, and its reader lets go at once (one reader
    // per session). While the handover is pending, the controller's next list doesn't read it again.
    await manager.start("s1", "http://e2/play", true);
    expect(manager.standbyStatus("s1")).toEqual([]);
    expect(manager.setStandbys("s1", ["http://e2/play"])).toEqual([]);

    await manager.stop("s1");
    expect(manager.standbyStatus("s1")).toBeUndefined();
  });

  test("opens a standby's source again when ffmpeg fails at once after its reader let go", async () => {
    await manager.start("s1", "http://e1/play", false);
    manager.setStandbys("s1", ["http://e2/play"]);
    await manager.start("s1", "http://e2/play", true);
    // The engine still counts the reader that just left, and refuses ffmpeg.
    children[1]?.emit("exit", 183, null);
    await vi.waitFor(
      () => {
        expect(children).toHaveLength(3);
      },
      { timeout: 5000 },
    );
    expect(manager.get("s1")?.status().pendingSource).toBe("http://e2/play");
  });

  test("gives up at once on a source that had no standby reader when ffmpeg fails", async () => {
    await manager.start("s1", "http://e1/play", false);
    await manager.start("s1", "http://e3/play", true);
    children[1]?.emit("exit", 183, null);
    await manager.get("s1")?.sync();
    expect(manager.get("s1")?.status().pendingSource).toBeNull();
    expect(children).toHaveLength(2);
  });
});
