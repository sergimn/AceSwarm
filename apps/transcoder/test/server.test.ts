import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { createLogger } from "@aceswarm/shared/logger";
import { createService, type Service } from "@aceswarm/shared/service";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PipelineSettings } from "../src/pipeline.ts";
import { PipelineManager, registerRoutes } from "../src/server.ts";
import type { RunFfmpeg } from "../src/slate.ts";
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

/** Stands in for ffmpeg making the slate: three segments of two seconds, where its command line says. */
const fakeSlate: RunFfmpeg = async (_command, args) => {
  const playlist = args.at(-1) ?? "";
  const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:2"];
  for (const name of ["seg_000.ts", "seg_001.ts", "seg_002.ts"]) {
    await writeFile(join(dirname(playlist), name), `slate ${name}`);
    lines.push("#EXTINF:2.000000,", name);
  }
  await writeFile(playlist, `${lines.join("\n")}\n`);
};

/** The segments a playlist lists, with `|` for a discontinuity. */
const listed = (playlist: string): string[] =>
  playlist
    .split("\n")
    .filter((line) => line.endsWith(".ts") || line === "#EXT-X-DISCONTINUITY")
    .map((line) => (line.startsWith("#") ? "|" : line));
const mediaSequence = (playlist = ""): number => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist)?.[1]);

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

  /** Writes what the stream's first ffmpeg run has written so far: a playlist of one segment, for each output. */
  async function writeSegments(): Promise<void> {
    for (const variant of ["full", "preview"]) {
      const directory = join(hlsDir, "stream1", "g1", variant);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "seg_000000.ts"), `${variant} video`);
      await writeFile(
        join(directory, "index.m3u8"),
        "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.000,\nseg_000000.ts\n",
      );
    }
  }

  /** How many times the stream's players outside the page got the slate where its video was. */
  const slates = async (): Promise<number | undefined> => {
    const line = (await service.registry.metrics())
      .split("\n")
      .find((one) => one.startsWith('aceswarm_pipeline_slates_total{stream="stream1"'));
    return line === undefined ? undefined : Number(line.split(" ").at(-1));
  };

  test("players outside the page get the full output's segments at an address of their own", async () => {
    const external = "/hls/stream1/external/index.m3u8";
    // No slate here (ffmpeg could not make it, say): as for the page, no playlist before the first segment.
    expect((await get(external)).json()).toEqual({ error: "no segments yet" });

    await manager.start("stream1", "http://e1/play", false);
    opened[0]?.layout(layoutOf(256));
    const early = await get(external);
    expect(early.statusCode).toBe(404);
    expect(early.json()).toEqual({ error: "no segments yet" });

    await writeSegments();
    const playlist = await get(external);
    expect(playlist.statusCode).toBe(200);
    expect(playlist.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    expect(playlist.headers["cache-control"]).toBe("no-cache");
    expect(playlist.body).toBe((await get("/hls/stream1/full/index.m3u8")).body);
    expect(playlist.body).toContain("#EXTINF:2.000,\n../g1/full/seg_000000.ts\n");
    // A player works the segment's address out from the playlist's: it is the full output's own file.
    const segment = new URL("../g1/full/seg_000000.ts", `http://transcoder${external}`).pathname;
    expect(segment).toBe("/hls/stream1/g1/full/seg_000000.ts");
    expect((await get(segment)).body).toBe("full video");

    // The router decodes the path, each part once, so these are the same playlist. The controller,
    // which knows which streams have one, reads an address the same way (`externalPlaylistStream`).
    for (const written of [
      "/hls/stream1/%65xternal/index.m3u8",
      "/hls/stream1/external/index%2Em3u8",
      "/hls/%73tream1/external/%69ndex.m3u8",
    ]) {
      expect((await get(written)).body, written).toBe(playlist.body);
    }
    // And these are not, there or here.
    for (const other of [
      "/hls/stream1/external/index.m3u8/",
      "/hls/stream1//external/index.m3u8",
      "/hls/stream1/external/index.m3u8;x",
      "/hls/stream1/External/index.m3u8",
      "/hls/stream1/%2565xternal/index.m3u8",
      "/hls/stream1%2Fexternal/index.m3u8",
      "/hls/stream1/external%2Findex.m3u8",
    ]) {
      expect((await get(other)).statusCode, other).toBe(404);
    }

    // The other playlists are as they were, and no other name is one.
    expect((await get("/hls/stream1/preview/index.m3u8")).body).toContain("../g1/preview/seg_000000.ts");
    expect((await get("/hls/stream1/other/index.m3u8")).json()).toEqual({ error: "no such stream" });
    expect((await get("/hls/stream1/g1/external/seg_000000.ts")).statusCode).toBe(404);
    // Without a slate there is none to fetch either.
    expect((await get("/hls/stream1/slate/seg_000.ts")).statusCode).toBe(404);
  });

  test("players outside the page get the slate until a stream has video, even before its pipeline", async () => {
    await manager.prepareSlate(fakeSlate);
    const external = "/hls/stream1/external/index.m3u8";
    const waiting = await get(external);
    expect(waiting.statusCode).toBe(200);
    expect(waiting.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    // Three segments of it to start with, so that the player has some to play behind the newest.
    expect(listed(waiting.body)).toEqual(["../slate/seg_000.ts", "../slate/seg_001.ts", "../slate/seg_002.ts"]);
    // Its segments are next to the stream's own, under a name no ffmpeg run has.
    const segment = new URL("../slate/seg_000.ts", `http://transcoder${external}`).pathname;
    expect(segment).toBe("/hls/stream1/slate/seg_000.ts");
    const file = await get(segment);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("video/mp2t");
    expect(file.body).toBe("slate seg_000.ts");
    for (const other of ["seg_003.ts", "index.m3u8", "seg_000.ts.tmp", "..%2Fstream1%2Fg1%2Ffull%2Fseg_000000.ts"]) {
      expect((await get(`/hls/stream1/slate/${other}`)).statusCode, other).toBe(404);
    }
    // The page's playlists are as they were: none for a stream without a pipeline.
    expect((await get("/hls/stream1/full/index.m3u8")).json()).toEqual({ error: "no such stream" });
    // What can't be a stream's id has no playlist.
    for (const id of ["s1", "Stream1", "stream_1", "a".repeat(33)]) {
      expect((await get(`/hls/${id}/external/index.m3u8`)).json(), id).toEqual({ error: "no such stream" });
    }

    // The stream starts: the slate goes on until its first segment, which comes behind a discontinuity.
    await manager.start("stream1", "http://e1/play", false);
    opened[0]?.layout(layoutOf(256));
    expect(listed((await get(external)).body).every((uri) => uri.startsWith("../slate/"))).toBe(true);
    expect((await get("/hls/stream1/full/index.m3u8")).json()).toEqual({ error: "no segments yet" });
    await writeSegments();
    const playing = (await get(external)).body;
    expect(listed(playing).slice(-3)).toEqual(["../slate/seg_002.ts", "|", "../g1/full/seg_000000.ts"]);
    expect(listed((await get("/hls/stream1/full/index.m3u8")).body)).toEqual(["../g1/full/seg_000000.ts"]);
    // The slate a stream starts with is not counted: its series is there, at 0.
    expect(await slates()).toBe(0);
  });

  test("players outside the page get the slate again when a stream's video stops coming, which is counted", async () => {
    await manager.prepareSlate(fakeSlate);
    await manager.start("stream1", "http://e1/play", false);
    opened[0]?.layout(layoutOf(256));
    await writeSegments();
    const now = Date.now();
    expect(listed((await manager.externalPlaylist("stream1", now)) ?? "")).toEqual(["../g1/full/seg_000000.ts"]);
    expect(await slates()).toBe(0);
    // Four seconds after its last segment nothing changed; a little over five, the slate is there.
    expect(listed((await manager.externalPlaylist("stream1", now + 4000)) ?? "")).toEqual(["../g1/full/seg_000000.ts"]);
    expect(listed((await manager.externalPlaylist("stream1", now + 6000)) ?? "")).toEqual([
      "../g1/full/seg_000000.ts",
      "|",
      "../slate/seg_000.ts",
    ]);
    expect(await slates()).toBe(1);
    // The loop goes round, behind a discontinuity each time, and counts once.
    expect(listed((await manager.externalPlaylist("stream1", now + 12_000)) ?? "")).toEqual([
      "../g1/full/seg_000000.ts",
      "|",
      "../slate/seg_000.ts",
      "../slate/seg_001.ts",
      "../slate/seg_002.ts",
      "|",
      "../slate/seg_000.ts",
    ]);
    expect(await slates()).toBe(1);
    // The page's playlist has the stream's segment only, as before.
    expect(listed((await get("/hls/stream1/full/index.m3u8")).body)).toEqual(["../g1/full/seg_000000.ts"]);
  });

  test("a stream's playlist for players outside the page goes with its pipeline, or when nobody asks before it has one", async () => {
    await manager.prepareSlate(fakeSlate);
    const now = Date.now();
    const sequenceOf = async (stream: string, at: number) => mediaSequence(await manager.externalPlaylist(stream, at));
    expect(await sequenceOf("waiting1", now)).toBe(0);
    await manager.start("stream1", "http://e1/play", false);
    // Some 40 seconds of slate later, both lists moved on.
    expect(await sequenceOf("waiting1", now + 41_000)).toBe(17);
    expect(await sequenceOf("stream1", now + 41_000)).toBe(17);
    // Nobody asked for either for over a minute. The stream without a pipeline starts over when
    // another playlist is made; the one with a pipeline goes on.
    expect(await sequenceOf("waiting2", now + 110_000)).toBe(0);
    expect(await sequenceOf("waiting1", now + 110_000)).toBe(0);
    expect(await sequenceOf("stream1", now + 110_000)).toBeGreaterThan(17);

    // A stream that stops (the controller disabled it) loses its playlist, with or without a pipeline.
    expect(await manager.stop("stream1")).toBe(true);
    expect(await sequenceOf("stream1", now + 112_000)).toBe(0);
    expect(await manager.stop("waiting2")).toBe(false);
    expect(await sequenceOf("waiting2", now + 150_000)).toBe(0);
  });

  test("no slate when ffmpeg can't make it: the playlists work as without one", async () => {
    await manager.prepareSlate(() => Promise.reject(new Error("spawn ffmpeg ENOENT")));
    expect((await get("/hls/stream1/external/index.m3u8")).json()).toEqual({ error: "no segments yet" });
    expect((await get("/hls/stream1/slate/seg_000.ts")).statusCode).toBe(404);
  });
});
