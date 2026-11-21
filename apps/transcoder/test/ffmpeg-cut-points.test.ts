/**
 * Checks `cutPointOf` against what the real ffmpeg of the transcoder image takes for key frames in
 * a copied H.264 video, which is where its HLS muxer can cut a segment: for each kind of key frame
 * an encoder makes, every access unit `cutPointOf` takes for a cut point has to be one that ffmpeg
 * flags, and the other way round. ffmpeg lists its packets with their flags in its `framecrc`
 * format. It also shows what key frames only decoding makes of each kind.
 *
 * It only runs with `FFMPEG_BIN` set to the ffmpeg 9.0.2 binary of the transcoder image (see
 * `ffmpeg-gaps.test.ts` for how to take it out):
 *
 *   FFMPEG_BIN=$PWD/ffmpeg npx vitest run apps/transcoder/test/ffmpeg-cut-points.test.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutPointOf, type CutPoint } from "../src/h264-cut-points.ts";
import { PACKET_BYTES, TsPackets } from "../src/ts-packets.ts";

const FFMPEG = process.env["FFMPEG_BIN"];
/** Where ffmpeg's MPEG-TS muxer puts the first stream. */
const VIDEO_PID = 0x1_00;
/** How much of an access unit the reader looks at. */
const HEAD_BYTES = 4096;

const ENCODE = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "12", "-c:v", "libx264"];
const KINDS = {
  "IDR frames": ["-preset", "veryfast", "-g", "50"],
  "I frames of an open GOP, with recovery points": [
    "-preset",
    "veryfast",
    "-x264-params",
    "open-gop=1:keyint=50:min-keyint=50:scenecut=0",
  ],
  "intra refresh, with recovery points and no I frames": [
    "-preset",
    "veryfast",
    "-x264-params",
    "intra-refresh=1:keyint=50",
  ],
} as const;

/** The access units of the video, one per PES as ffmpeg muxes them, each from its first byte on. */
function accessUnits(file: string): Uint8Array[] {
  const units: number[][] = [];
  new TsPackets().push(readFileSync(file), (data, at) => {
    const pid = (((data[at + 1] ?? 0) & 0x1f) << 8) | (data[at + 2] ?? 0);
    if (pid !== VIDEO_PID || ((data[at + 3] ?? 0) & 0x10) === 0) {
      return;
    }
    const adaptation = ((data[at + 3] ?? 0) & 0x20) === 0 ? 0 : 1 + (data[at + 4] ?? 0);
    let payload = at + 4 + adaptation;
    if (((data[at + 1] ?? 0) & 0x40) !== 0) {
      payload += 9 + (data[payload + 8] ?? 0);
      units.push([]);
    }
    units.at(-1)?.push(...data.subarray(payload, at + PACKET_BYTES));
  });
  return units.map((unit) => Uint8Array.from(unit));
}

/** Whether ffmpeg flags each video packet as a key frame, in the order it demuxes them. */
function ffmpegKeys(file: string): boolean[] {
  const listing = execFileSync(FFMPEG ?? "", [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:v",
    "-c",
    "copy",
    "-f",
    "framecrc",
    "-",
  ]);
  return listing
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("0,"))
    .map((line) => !line.includes(", F=0x"));
}

/**
 * Checks that `cutPointOf` and ffmpeg agree on every access unit of the file. Returns the cut
 * points, in order, and of how many units.
 */
function agree(file: string): { points: CutPoint[]; units: number } {
  const keys = ffmpegKeys(file);
  const units = accessUnits(file);
  expect(units).toHaveLength(keys.length);
  const points = units.map((unit) => cutPointOf(unit.subarray(0, HEAD_BYTES)));
  expect(points.map((point) => (point === undefined ? undefined : point !== "none"))).toEqual(keys);
  return { points: points.filter((point) => point !== undefined && point !== "none"), units: units.length };
}

/** How many pictures ffmpeg's decoder gives of the file's video when it decodes key frames only, as the previews may. */
function keyFramesOnlyPictures(file: string): number {
  const decoded = spawnSync(FFMPEG ?? "", [
    "-hide_banner",
    "-skip_frame",
    "nokey",
    "-i",
    file,
    "-vf",
    "showinfo",
    "-f",
    "null",
    "-",
  ]);
  return decoded.stderr
    .toString()
    .split("\n")
    .filter((line) => line.includes("Parsed_showinfo") && line.includes(" n:")).length;
}

describe.skipIf(FFMPEG === undefined)("cutsAt and ffmpeg's own key frames", () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "aceswarm-cut-points-"));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function encode(name: string, args: readonly string[], ...then: string[]): string {
    const path = join(directory, `${name}.ts`);
    execFileSync(FFMPEG ?? "", ["-v", "error", "-y", ...ENCODE, ...args, path]);
    if (then.length === 0) {
      return path;
    }
    const after = join(directory, `${name}-then.ts`);
    execFileSync(FFMPEG ?? "", ["-v", "error", "-y", "-i", path, "-map", "0", "-c", "copy", ...then, after]);
    return after;
  }

  it.each(Object.entries(KINDS))("finds the cut points of %s", (name, args) => {
    const { points, units } = agree(encode(name.replaceAll(" ", "-"), args));
    expect(units).toBe(300);
    // One every 2 s, from an IDR picture.
    expect(points).toHaveLength(6);
    expect(points[0]).toBe("idr");
    expect(new Set(points.slice(1))).toEqual(new Set([name === "IDR frames" ? "idr" : "recovery-point"]));
  });

  it("finds none where an open GOP has no recovery points: only its first frame, an IDR", () => {
    const file = encode(
      "no-recovery-points",
      KINDS["I frames of an open GOP, with recovery points"],
      "-bsf:v",
      "filter_units=remove_types=6",
    );
    expect(agree(file).points).toEqual(["idr"]);
  });

  // Why key frames only decoding comes back with a copy only at an IDR picture (see `SourceFeeds`).
  it("gives a picture of every IDR when it decodes key frames only, and next to none of recovery points", () => {
    const pictures = Object.entries(KINDS).map(([name, args]) =>
      keyFramesOnlyPictures(encode(name.replaceAll(" ", "-"), args)),
    );
    const [idr, openGop, intraRefresh] = pictures;
    expect(idr).toBe(6);
    // The first IDR, and a few that get out of the decoder's reordering.
    expect(openGop).toBeLessThanOrEqual(3);
    // The first IDR alone: a picture refreshed bit by bit is never whole when the others are skipped.
    expect(intraRefresh).toBe(1);
  });
});
