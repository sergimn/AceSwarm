import { describe, expect, it } from "vitest";
import { parseInputVideoCodec, ProgressParser } from "../src/progress.ts";

describe("ProgressParser", () => {
  it("returns complete blocks across chunk boundaries", () => {
    const parser = new ProgressParser();
    expect(parser.push("frame=10\nfps=25.0\nbitrate=N/A\nprog")).toEqual([]);
    expect(parser.push("ress=continue\nframe=35\nfps=N/A\nprogress=end\n")).toEqual([
      { frame: 10, fps: 25, progress: "continue" },
      { frame: 35, fps: undefined, progress: "end" },
    ]);
  });
});

describe("parseInputVideoCodec", () => {
  it("finds the input video codec in ffmpeg's banner", () => {
    expect(parseInputVideoCodec("  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p")).toBe(
      "h264",
    );
    expect(parseInputVideoCodec("  Stream #0:1[0x101](und): Video: mpeg2video (Main), yuv420p")).toBe("mpeg2video");
    expect(parseInputVideoCodec("  Stream #0:1[0x101]: Audio: aac (LC)")).toBeUndefined();
  });
});
