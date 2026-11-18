import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, type FfmpegPlan } from "../src/ffmpeg-args.ts";

const PLAN: FfmpegPlan = {
  source: "http://172.31.250.130:6878/ace/r/abc",
  directory: "/hls/s1/3",
  fullMode: "copy",
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
};

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** The format of each output, in order. */
function formats(args: string[]): string[] {
  return args.filter((_, index) => args[index - 1] === "-f");
}

describe("buildFfmpegArgs", () => {
  it("reads the source once and writes full, preview and thumbnail outputs", () => {
    const args = buildFfmpegArgs(PLAN);
    expect(args.filter((arg) => arg === "-i")).toHaveLength(1);
    expect(valueAfter(args, "-i")).toBe(PLAN.source);
    expect(args).toContain("/hls/s1/3/full/index.m3u8");
    expect(args).toContain("/hls/s1/3/preview/index.m3u8");
    expect(args.at(-1)).toBe("/hls/s1/3/thumbnail.jpg");
  });

  it("makes no preview while the admin allows thumbnails only, and keeps the full stream and thumbnail", () => {
    const args = buildFfmpegArgs({ ...PLAN, thumbnailsOnly: true });
    expect(args.join(" ")).not.toContain("/preview/");
    expect(args).toContain("/hls/s1/3/full/index.m3u8");
    expect(args.at(-1)).toBe("/hls/s1/3/thumbnail.jpg");
    expect(formats(args)).toEqual(["hls", "image2"]);
    expect(formats(buildFfmpegArgs(PLAN))).toEqual(["hls", "hls", "image2"]);
    // The full stream is copied: no H.264 encode is left.
    expect(args).not.toContain("libx264");
    // A stream that isn't H.264 still gets its full stream encoded.
    const transcode = buildFfmpegArgs({ ...PLAN, fullMode: "transcode", thumbnailsOnly: true });
    expect(formats(transcode)).toEqual(["hls", "image2"]);
    expect(transcode.filter((arg) => arg === "libx264")).toHaveLength(1);
  });

  it("waits for slow engines before giving up on the input", () => {
    expect(valueAfter(buildFfmpegArgs(PLAN), "-rw_timeout")).toBe("60000000");
  });

  it("copies H.264 and transcodes everything else", () => {
    expect(valueAfter(buildFfmpegArgs(PLAN), "-c:v")).toBe("copy");
    const transcode = buildFfmpegArgs({ ...PLAN, fullMode: "transcode" });
    expect(valueAfter(transcode, "-c:v")).toBe("libx264");
    expect(valueAfter(transcode, "-vf")).toBe("scale=-2:'min(1080,ih)'");
  });

  it("decodes only key frames in keyframes mode", () => {
    const args = buildFfmpegArgs({ ...PLAN, previewMode: "keyframes" });
    expect(args.indexOf("-skip_frame")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("scale=-2:270");
    expect(buildFfmpegArgs(PLAN)).toContain("fps=15,scale=-2:270");
  });

  it("caps the preview bitrate", () => {
    const args = buildFfmpegArgs(PLAN);
    expect(valueAfter(args, "-maxrate")).toBe("480k");
    expect(valueAfter(args, "-bufsize")).toBe("800k");
  });
});
