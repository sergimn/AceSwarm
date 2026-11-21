import { describe, expect, it } from "vitest";
import { InputBanner, Lines, parseInputVideoCodec, ProgressParser } from "../src/progress.ts";

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

describe("Lines", () => {
  it("puts a line together that came in two chunks", () => {
    const lines = new Lines();
    expect(lines.push("Input #0, mpegts, from 'pipe:0':\n  Stream #0:0[0x100]: Vid")).toEqual([
      "Input #0, mpegts, from 'pipe:0':",
    ]);
    expect(lines.push("eo: hevc (Main)\n")).toEqual(["Stream #0:0[0x100]: Video: hevc (Main)"]);
  });

  it("takes a carriage return for the end of a line, and leaves out empty lines", () => {
    const lines = new Lines();
    expect(lines.push("frame=  1 fps=0.0\rframe=  2 fps=1.0\r\n\n  last")).toEqual([
      "frame=  1 fps=0.0",
      "frame=  2 fps=1.0",
    ]);
    expect(lines.push(" one\n")).toEqual(["last one"]);
  });
});

/** Every codec a banner names, fed these lines. */
const codecs = (lines: string[]): (string | undefined)[] => {
  const banner = new InputBanner();
  return lines.map((line) => banner.push(line)).filter((codec) => codec !== undefined);
};

describe("InputBanner", () => {
  it("takes the source's video from the input's streams, not from the outputs'", () => {
    // A run that re-encodes HEVC lists its H.264 output in the same words as an input.
    expect(
      codecs([
        "Input #0, mpegts, from 'pipe:0':",
        "Duration: N/A, start: 1.400000, bitrate: N/A",
        "Program 1",
        "Stream #0:0[0xd3]: Video: hevc (Main) (HEVC / 0x43564548), yuv420p(tv), 1920x1080, 25 fps",
        "Stream #0:1[0xdd]: Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo",
        "Stream mapping:",
        "Stream #0:0 -> #0:0 (hevc (native) -> h264 (libx264))",
        "Output #0, hls, to '/hls/full/index.m3u8':",
        "Stream #0:0: Video: h264, yuv420p(tv, progressive), 1920x1080, q=2-31, 25 fps",
      ]),
    ).toEqual(["hevc"]);
  });

  it("finds nothing once the outputs are listed, when no input line named the video", () => {
    expect(
      codecs([
        "Input #0, mpegts, from 'pipe:0':",
        "Stream #0:0[0xdd]: Audio: aac (LC), 48000 Hz, stereo",
        "Output #0, hls, to '/hls/full/index.m3u8':",
        "Stream #0:0: Video: h264, yuv420p, 1920x1080",
      ]),
    ).toEqual([]);
  });

  it("names the first video stream only", () => {
    expect(
      codecs([
        "Stream #0:0[0x100]: Video: mpeg2video (Main), yuv420p",
        "Stream #0:1[0x102]: Video: h264 (High), yuv420p",
      ]),
    ).toEqual(["mpeg2video"]);
  });
});
