import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSlate, SLATE_PICTURE, slateArgs, slateFile, type RunFfmpeg, type SlateSettings } from "../src/slate.ts";

/** What ffmpeg writes for a slate of three segments. */
const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS
#EXTINF:2.000000,
seg_000.ts
#EXTINF:2.000000,
seg_001.ts
#EXTINF:1.960000,
seg_002.ts
#EXT-X-ENDLIST
`;

/** An ffmpeg that writes `playlist` where its command line says, if it writes one. */
const ffmpeg =
  (playlist: string | undefined, calls: unknown[][] = []): RunFfmpeg =>
  async (...call) => {
    calls.push(call);
    if (playlist !== undefined) {
      await writeFile(call[1].at(-1) ?? "", playlist);
    }
  };

describe("the slate", () => {
  let hlsDir: string;
  let settings: SlateSettings;

  beforeEach(async () => {
    hlsDir = await mkdtemp(join(tmpdir(), "slate-test-"));
    settings = { ffmpegPath: "/usr/local/bin/ffmpeg", hlsDir, segmentSeconds: 2, audioBitrateKbps: 160 };
  });

  afterEach(async () => {
    await rm(hlsDir, { recursive: true, force: true });
  });

  it("has a picture of 1280 by 720, which the encoder and every player take", () => {
    const png = readFileSync(SLATE_PICTURE);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 720]);
  });

  it("is made by ffmpeg from the picture, as H.264 and AAC in segments like a stream's", async () => {
    const calls: unknown[][] = [];
    const slate = await makeSlate(settings, ffmpeg(PLAYLIST, calls));
    const directory = join(hlsDir, "_slate");
    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0] as [string, string[], { timeout: number }];
    expect(command).toBe("/usr/local/bin/ffmpeg");
    expect(options.timeout).toBeGreaterThan(10_000);
    expect(args).toEqual(slateArgs(settings, directory));
    const line = args.join(" ");
    expect(line).toContain(`-loop 1 -framerate 25 -i ${SLATE_PICTURE} `);
    expect(line).toContain("-f lavfi -i anullsrc=r=48000:cl=stereo -t 30 ");
    expect(line).toContain("-c:v libx264 ");
    expect(line).toContain("-pix_fmt yuv420p ");
    // A key frame at the start of every segment, of the stream's own segment length.
    expect(line).toContain("-force_key_frames expr:gte(t,n_forced*2) ");
    expect(line).toContain("-c:a aac -b:a 160k -ac 2 ");
    expect(line).toContain("-f hls -hls_time 2 -hls_list_size 0 ");
    expect(line.endsWith(`-hls_segment_filename ${directory}/seg_%03d.ts ${directory}/index.m3u8`)).toBe(true);

    // Named as a stream's playlist names its own segments: relative to the stream.
    expect(slate).toEqual({
      directory,
      segments: [
        { uri: "../slate/seg_000.ts", duration: 2 },
        { uri: "../slate/seg_001.ts", duration: 2 },
        { uri: "../slate/seg_002.ts", duration: 1.96 },
      ],
    });
  });

  it("follows the segment length and the picture it is given", () => {
    const line = slateArgs({ ...settings, segmentSeconds: 4, picture: "/tmp/other.png" }, "/hls/_slate").join(" ");
    expect(line).toContain("-i /tmp/other.png ");
    expect(line).toContain("-force_key_frames expr:gte(t,n_forced*4) ");
    expect(line).toContain("-hls_time 4 ");
  });

  it("starts from an empty folder: a slate from before is gone", async () => {
    const directory = join(hlsDir, "_slate");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "seg_009.ts"), "old");
    await makeSlate(settings, ffmpeg(PLAYLIST));
    expect(existsSync(join(directory, "seg_009.ts"))).toBe(false);
  });

  it("fails when ffmpeg does, or writes nothing to play", async () => {
    await expect(makeSlate(settings, () => Promise.reject(new Error("spawn ffmpeg ENOENT")))).rejects.toThrow("ENOENT");
    await expect(makeSlate(settings, ffmpeg(undefined))).rejects.toThrow("ENOENT");
    await expect(makeSlate(settings, ffmpeg("#EXTM3U\n"))).rejects.toThrow("no segment");
    // A segment under another name, or one that lasts no time, is not one of the slate's.
    const odd = "#EXTM3U\n#EXTINF:2.0,\n../elsewhere/seg_000.ts\n#EXTINF:0.0,\nseg_001.ts\n";
    await expect(makeSlate(settings, ffmpeg(odd))).rejects.toThrow("no segment");
  });

  it("gives out the files of its own segments only", async () => {
    const slate = await makeSlate(settings, ffmpeg(PLAYLIST));
    expect(slateFile(slate, "seg_001.ts")).toBe(join(hlsDir, "_slate", "seg_001.ts"));
    for (const name of ["seg_003.ts", "index.m3u8", "../abcdef/g1/full/seg_000000.ts", "", "seg_001.ts/"]) {
      expect(slateFile(slate, name), name).toBeUndefined();
    }
    expect(slateFile(undefined, "seg_001.ts")).toBeUndefined();
  });
});
