import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createLogger } from "@aceswarm/shared/logger";
import { createService, type Service } from "@aceswarm/shared/service";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PipelineSettings } from "../src/pipeline.ts";
import { PipelineManager, registerRoutes } from "../src/server.ts";
import { fakeSources, layoutOf, type FakeSource } from "./fake-source.ts";

const logger = createLogger("test", "silent");

/** An ffmpeg process that runs until the test ends. */
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

describe("the transcoder's playlists", () => {
  let hlsDir: string;
  let service: Service;
  let manager: PipelineManager;
  /** Every connection to a source, in order. */
  let opened: FakeSource[] = [];

  beforeEach(async () => {
    hlsDir = await mkdtemp(join(tmpdir(), "transcoder-server-test-"));
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
    const sources = fakeSources();
    opened = sources.opened;
    manager = new PipelineManager(service, settings, logger, fakeFfmpeg, undefined, { openSource: sources.open });
    registerRoutes(service, manager);
  });

  afterEach(async () => {
    await manager.stopAll();
    await service.app.close();
    await rm(hlsDir, { recursive: true, force: true });
  });

  const get = async (url: string) => service.app.inject({ method: "GET", url });

  /** Writes what a stream's first ffmpeg run has written so far: a playlist of one segment, for each output. */
  async function writeSegments(stream: string): Promise<void> {
    for (const variant of ["full", "preview"]) {
      const directory = join(hlsDir, stream, "g1", variant);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "seg_000000.ts"), `${variant} video`);
      await writeFile(
        join(directory, "index.m3u8"),
        "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,\nseg_000000.ts\n",
      );
    }
  }

  test("players outside the page get the full output's playlist and segments, at an address of their own", async () => {
    const external = "/hls/s1/external/index.m3u8";
    expect((await get(external)).json()).toEqual({ error: "no such stream" });

    await manager.start("s1", "http://e1/play", false);
    opened[0]?.layout(layoutOf(256));
    // As for the page: no playlist before the stream's first segment.
    const early = await get(external);
    expect(early.statusCode).toBe(404);
    expect(early.json()).toEqual({ error: "no segments yet" });

    await writeSegments("s1");
    const playlist = await get(external);
    expect(playlist.statusCode).toBe(200);
    expect(playlist.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    expect(playlist.headers["cache-control"]).toBe("no-cache");
    expect(playlist.body).toBe((await get("/hls/s1/full/index.m3u8")).body);
    expect(playlist.body).toContain("#EXTINF:2.000,\n../g1/full/seg_000000.ts\n");
    // A player works the segment's address out from the playlist's: it is the full output's own file.
    const segment = new URL("../g1/full/seg_000000.ts", `http://transcoder${external}`).pathname;
    expect(segment).toBe("/hls/s1/g1/full/seg_000000.ts");
    expect((await get(segment)).body).toBe("full video");

    // The other playlists are as they were, and no other name is one.
    expect((await get("/hls/s1/preview/index.m3u8")).body).toContain("../g1/preview/seg_000000.ts");
    expect((await get("/hls/s1/other/index.m3u8")).json()).toEqual({ error: "no such stream" });
    expect((await get("/hls/s1/g1/external/seg_000000.ts")).statusCode).toBe(404);
  });
});
