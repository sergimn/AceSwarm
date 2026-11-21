/**
 * Checks `cutsAt` against what the real ffmpeg of the transcoder image takes for key frames in a
 * copied H.264 video, which is where its HLS muxer can cut a segment: for each kind of key frame an
 * encoder makes, every access unit `cutsAt` takes for a cut point has to be one that ffmpeg flags,
 * and the other way round. ffmpeg lists its packets with their flags in its `framecrc` format.
 *
 * It only runs with `FFMPEG_BIN` set to the ffmpeg 9.0.2 binary of the transcoder image (see
 * `ffmpeg-gaps.test.ts` for how to take it out):
 *
 *   FFMPEG_BIN=$PWD/ffmpeg npx vitest run apps/transcoder/test/ffmpeg-cut-points.test.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutsAt } from "../src/h264-cut-points.ts";
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

/** Checks that `cutsAt` and ffmpeg agree on every access unit of the file. Returns how many are key frames, of how many. */
function agree(file: string): { keys: number; units: number } {
  const keys = ffmpegKeys(file);
  const units = accessUnits(file);
  expect(units).toHaveLength(keys.length);
  expect(units.map((unit) => cutsAt(unit.subarray(0, HEAD_BYTES)))).toEqual(keys);
  return { keys: keys.filter(Boolean).length, units: units.length };
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
    const { keys, units } = agree(encode(name.replaceAll(" ", "-"), args));
    expect(units).toBe(300);
    // One every 2 s.
    expect(keys).toBe(6);
  });

  it("finds none where an open GOP has no recovery points: only its first frame, an IDR", () => {
    const file = encode(
      "no-recovery-points",
      KINDS["I frames of an open GOP, with recovery points"],
      "-bsf:v",
      "filter_units=remove_types=6",
    );
    expect(agree(file).keys).toBe(1);
  });
});
