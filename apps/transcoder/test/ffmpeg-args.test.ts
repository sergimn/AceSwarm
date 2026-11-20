import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, decodesKeyFramesOnly, type FfmpegPlan } from "../src/ffmpeg-args.ts";

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

/** The options of the preview output: from its `-map` up to the thumbnail's, empty without a preview. */
function previewOutput(args: string[]): string[] {
  const maps = args.map((arg, index) => (arg === "-map" ? index : -1)).filter((index) => index >= 0);
  // The full output has two maps (video, audio), the preview one and the thumbnail one.
  return maps.length === 4 ? args.slice(maps[2], maps[3]) : [];
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
    // Live previews decode every frame, whether the full stream is copied or re-encoded.
    expect(args).not.toContain("-skip_frame");
    expect(buildFfmpegArgs({ ...PLAN, fullMode: "transcode" })).not.toContain("-skip_frame");
  });

  it("makes no preview in thumbnails mode, and decodes key frames only while the full stream is copied", () => {
    const args = buildFfmpegArgs({ ...PLAN, previewMode: "thumbnails" });
    expect(args.join(" ")).not.toContain("/preview/");
    expect(args).toContain("/hls/s1/3/full/index.m3u8");
    expect(args.at(-1)).toBe("/hls/s1/3/thumbnail.jpg");
    expect(formats(args)).toEqual(["hls", "image2"]);
    expect(formats(buildFfmpegArgs(PLAN))).toEqual(["hls", "hls", "image2"]);
    // The full stream is copied, so no H.264 encode is left, and only the thumbnail decodes.
    expect(args).not.toContain("libx264");
    expect(valueAfter(args, "-skip_frame")).toBe("nokey");
    expect(args.indexOf("-skip_frame")).toBeLessThan(args.indexOf("-i"));
  });

  it("decodes every frame in thumbnails mode for a full stream that is re-encoded", () => {
    const args = buildFfmpegArgs({ ...PLAN, fullMode: "transcode", previewMode: "thumbnails" });
    expect(formats(args)).toEqual(["hls", "image2"]);
    expect(args.filter((arg) => arg === "libx264")).toHaveLength(1);
    expect(args).not.toContain("-skip_frame");
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
    expect(valueAfter(args, "-skip_frame")).toBe("nokey");
    expect(args.indexOf("-skip_frame")).toBeLessThan(args.indexOf("-i"));
    expect(valueAfter(previewOutput(args), "-vf")).toBe("scale=-2:270");
    // Key frames are sparse already: no frame rate to enforce.
    expect(previewOutput(args)).not.toContain("-r");
    expect(previewOutput(args)).not.toContain("-fps_mode");
  });

  it("thins the preview out in the filter and sets its frame rate on the output", () => {
    const preview = previewOutput(buildFfmpegArgs(PLAN));
    // One frame for each 1/15 s slot of the stream's time, scaled after thinning.
    expect(valueAfter(preview, "-vf")).toBe(
      "select='isnan(prev_selected_t)+gt(floor(t*15),floor(prev_selected_t*15))',scale=-2:270",
    );
    expect(valueAfter(preview, "-r")).toBe("15");
    expect(valueAfter(preview, "-fps_mode")).toBe("cfr");
    // The frame rate stays on the output, after -vf and before the encoder's options.
    expect(preview.indexOf("-r")).toBeGreaterThan(preview.indexOf("-vf"));
    expect(preview.indexOf("-r")).toBeLessThan(preview.indexOf("-c:v"));

    const ten = previewOutput(buildFfmpegArgs({ ...PLAN, previewFps: 10 }));
    expect(valueAfter(ten, "-vf")).toContain("floor(t*10),floor(prev_selected_t*10)");
    expect(valueAfter(ten, "-r")).toBe("10");
  });

  it("never lets a filter graph repeat frames of the video, apart from the thumbnail's", () => {
    // ffmpeg 9's scheduler can deadlock when a graph with a repeating fps filter shares the decoder
    // with another graph while the full stream is copied or re-encoded first: see the architecture
    // notes on ffmpeg freezing at timestamp gaps. The previews and the full video leave the repeating to
    // the output's frame rate, which acts after the graph.
    for (const fullMode of ["copy", "transcode"] as const) {
      for (const previewMode of ["video", "keyframes", "thumbnails"] as const) {
        for (const allFrames of [false, true]) {
          const args = buildFfmpegArgs({ ...PLAN, fullMode, previewMode, allFrames });
          const filters = args.filter((_, index) => args[index - 1] === "-vf");
          const repeating = filters.filter((filter) => /(^|,)fps=/.test(filter));
          expect(repeating, `${fullMode} ${previewMode} ${String(allFrames)}`).toEqual([
            "fps=1/10:round=up:start_time=0,scale=-2:180",
          ]);
        }
      }
    }
  });

  it("decodes every frame in keyframes mode once the broadcast has no key frames to decode alone", () => {
    const args = buildFfmpegArgs({ ...PLAN, previewMode: "keyframes", allFrames: true });
    expect(args).not.toContain("-skip_frame");
    // Every frame is decoded, so the preview thins them out as in video mode.
    expect(valueAfter(previewOutput(args), "-vf")).toContain("select=");
    expect(valueAfter(previewOutput(args), "-r")).toBe("15");
    expect(args).toEqual(buildFfmpegArgs({ ...PLAN, previewMode: "video" }));
    expect(decodesKeyFramesOnly({ ...PLAN, previewMode: "keyframes" })).toBe(true);
    expect(decodesKeyFramesOnly({ ...PLAN, previewMode: "keyframes", allFrames: true })).toBe(false);
    expect(decodesKeyFramesOnly(PLAN)).toBe(false);
  });

  it("writes the first thumbnail with the first frame and one every interval, from one encoder thread", () => {
    for (const previewMode of ["video", "keyframes", "thumbnails"] as const) {
      const args = buildFfmpegArgs({ ...PLAN, previewMode });
      const thumbnail = args.slice(args.lastIndexOf("-map"));
      // `round=up` takes a frame as soon as its slot begins, and `start_time=0` keeps a first frame
      // that starts a little after the audio in the first slot, so neither waits for half an interval.
      expect(valueAfter(thumbnail, "-vf"), previewMode).toBe("fps=1/10:round=up:start_time=0,scale=-2:180");
      expect(thumbnail.at(-1), previewMode).toBe("/hls/s1/3/thumbnail.jpg");
      // Only the thumbnail's encoder: the mjpeg encoder holds each picture until the next without it.
      expect(thumbnail.indexOf("-threads"), previewMode).toBeGreaterThan(-1);
      expect(valueAfter(thumbnail, "-threads"), previewMode).toBe("1");
      expect(
        args.filter((arg) => arg === "-threads"),
        previewMode,
      ).toHaveLength(1);
    }
    const slow = buildFfmpegArgs({ ...PLAN, thumbnailIntervalSeconds: 30 });
    expect(slow).toContain("fps=1/30:round=up:start_time=0,scale=-2:180");
  });

  it("caps the preview bitrate", () => {
    const args = buildFfmpegArgs(PLAN);
    expect(valueAfter(args, "-maxrate")).toBe("480k");
    expect(valueAfter(args, "-bufsize")).toBe("800k");
  });
});
