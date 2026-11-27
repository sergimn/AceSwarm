/**
 * Makes the slate with the real ffmpeg of the transcoder image, and checks what players need of
 * it: the picture in the repository encodes, into segments laid out like a stream's full output
 * (players built on ffmpeg read on over a discontinuity as if nothing changed), each of which
 * starts with a key frame, with time stamps that run on through the loop.
 *
 * Like `ffmpeg-gaps.test.ts`, it only runs with `FFMPEG_BIN` set to the ffmpeg 9.0.2 binary of the
 * transcoder image (see there for how to take it out):
 *
 *   FFMPEG_BIN=$PWD/ffmpeg npx vitest run apps/transcoder/test/ffmpeg-slate.test.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Slate } from "../src/external-playlist.ts";
import { buildFfmpegArgs } from "../src/ffmpeg-args.ts";
import { cutPointOf } from "../src/h264-cut-points.ts";
import { makeSlate, slateFile } from "../src/slate.ts";
import { PACKET_BYTES, TsPackets } from "../src/ts-packets.ts";
import { describeLayout, TsTables } from "../src/ts-tables.ts";

const FFMPEG = process.env["FFMPEG_BIN"];
/** Where ffmpeg's MPEG-TS muxer puts the first stream: the video. */
const VIDEO_PID = 0x1_00;
const SEGMENT_SECONDS = 2;
/** MPEG-TS counts time in 90 kHz ticks. */
const TICKS = 90_000;

/** What a segment's tables say it carries. */
function layoutOf(file: string): string | undefined {
  const tables = new TsTables();
  new TsPackets().push(readFileSync(file), (data, at) => {
    tables.packet(data, at);
  });
  return tables.layout === undefined ? undefined : describeLayout(tables.layout);
}

/** The first picture of a segment's video: its time stamp (90 kHz), and how its data begins. */
function firstPicture(file: string): { pts: number; head: Uint8Array } | undefined {
  let pts: number | undefined;
  const head: number[] = [];
  new TsPackets().push(readFileSync(file), (data, at) => {
    const pid = (((data[at + 1] ?? 0) & 0x1f) << 8) | (data[at + 2] ?? 0);
    const starts = ((data[at + 1] ?? 0) & 0x40) !== 0;
    if (
      pid !== VIDEO_PID ||
      ((data[at + 3] ?? 0) & 0x10) === 0 ||
      (pts !== undefined && starts) ||
      head.length > 4096
    ) {
      return;
    }
    const adaptation = ((data[at + 3] ?? 0) & 0x20) === 0 ? 0 : 1 + (data[at + 4] ?? 0);
    let payload = at + 4 + adaptation;
    if (pts === undefined) {
      if (!starts) {
        return;
      }
      const byte = (offset: number): number => data[payload + 9 + offset] ?? 0;
      pts = ((byte(0) >> 1) & 7) * 2 ** 30 + (byte(1) << 22) + ((byte(2) >> 1) << 15) + (byte(3) << 7) + (byte(4) >> 1);
      payload += 9 + (data[payload + 8] ?? 0);
    }
    head.push(...data.subarray(payload, at + PACKET_BYTES));
  });
  return pts === undefined ? undefined : { pts, head: Uint8Array.from(head) };
}

describe.skipIf(FFMPEG === undefined)("the slate, made by the image's ffmpeg", () => {
  let directory: string;
  let slate: Slate;
  let files: string[];

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "aceswarm-slate-"));
    slate = await makeSlate({
      ffmpegPath: FFMPEG ?? "ffmpeg",
      hlsDir: directory,
      segmentSeconds: SEGMENT_SECONDS,
      audioBitrateKbps: 160,
    });
    files = slate.segments.map(({ uri }) => slateFile(slate, uri.slice("../slate/".length)) ?? "");
  }, 60_000);

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is a loop of 30 seconds, in segments as long as a stream's", () => {
    expect(slate.segments.map(({ duration }) => duration)).toEqual(Array.from({ length: 15 }, () => SEGMENT_SECONDS));
    expect(slate.segments.map(({ uri }) => uri).slice(0, 2)).toEqual(["../slate/seg_000.ts", "../slate/seg_001.ts"]);
    expect(files.every((file) => file.startsWith(join(directory, "_slate")))).toBe(true);
    // A third of a megabyte or so: it sits in memory, in the folder of the streams' segments.
    const bytes = files.reduce((total, file) => total + readFileSync(file).length, 0);
    expect(bytes).toBeLessThan(1_000_000);
  });

  it("has the layout of a stream's full output in every segment", () => {
    // A stream's full output, by the transcoder's own command line (its video re-encoded, as for a
    // broadcast that is not H.264), from six seconds of a test picture with a tone.
    const stream = join(directory, "stream");
    const made = spawnSync(
      FFMPEG ?? "ffmpeg",
      "-hide_banner -loglevel error -f lavfi -i testsrc2=size=480x270:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 6 -c:v mpeg2video -c:a mp2 -f mpegts pipe:1".split(
        " ",
      ),
      { maxBuffer: 64 * 1024 * 1024 },
    );
    expect(made.status, made.stderr.toString()).toBe(0);
    mkdirSync(join(stream, "full"), { recursive: true });
    const run = spawnSync(
      FFMPEG ?? "ffmpeg",
      buildFfmpegArgs({
        directory: stream,
        fullMode: "transcode",
        previewMode: "thumbnails",
        previewHeight: 270,
        previewFps: 15,
        previewBitrateKbps: 400,
        fullTranscodeMaxHeight: 1080,
        audioBitrateKbps: 160,
        segmentSeconds: SEGMENT_SECONDS,
        playlistSize: 6,
        thumbnailIntervalSeconds: 10,
        inputTimeoutSeconds: 60,
      }),
      { input: made.stdout, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(run.status, run.stderr.toString().slice(-2000)).toBe(0);
    const full = layoutOf(join(stream, "full", "seg_000000.ts"));
    expect(full).toBe("program 1 [256:h264 257:0x0f]");
    // Every segment says so itself: a player may start on any of them.
    expect(files.map((file) => layoutOf(file))).toEqual(files.map(() => full));
  }, 60_000);

  it("starts every segment with a key frame, and its time runs on from one segment to the next", () => {
    const pictures = files.map((file) => firstPicture(file));
    expect(pictures.map((picture) => picture && cutPointOf(picture.head))).toEqual(files.map(() => "idr"));
    const first = pictures[0]?.pts ?? NaN;
    expect(pictures.map((picture) => picture?.pts)).toEqual(
      files.map((_, index) => first + index * SEGMENT_SECONDS * TICKS),
    );
  });
});
