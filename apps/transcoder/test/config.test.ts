import { describe, expect, it } from "vitest";
import { loadConfig, previewMode } from "../src/config.ts";

describe("preview mode", () => {
  it("makes the previews PREVIEW_MODE asks for unless the admin turned on low CPU previews", () => {
    expect(loadConfig({}).LOW_CPU_PREVIEWS).toBe(false);
    expect(previewMode(loadConfig({}))).toBe("video");
    // compose.yaml passes "false" while the line in .env stays commented out.
    expect(previewMode(loadConfig({ PREVIEW_MODE: "keyframes", LOW_CPU_PREVIEWS: "false" }))).toBe("keyframes");
    expect(() => loadConfig({ PREVIEW_MODE: "thumbnails" })).toThrow(/PREVIEW_MODE/);
  });

  it("makes thumbnails only with low CPU previews, whatever PREVIEW_MODE says", () => {
    for (const mode of ["video", "keyframes"]) {
      expect(previewMode(loadConfig({ PREVIEW_MODE: mode, LOW_CPU_PREVIEWS: "true" })), mode).toBe("thumbnails");
    }
  });
});

describe("stuck ffmpeg runs", () => {
  it("restarts a run whose full output stalled for 30 s, or whose memory grew by over 512 MB, by default", () => {
    expect(loadConfig({}).FULL_OUTPUT_STALL_SECONDS).toBe(30);
    expect(loadConfig({}).FFMPEG_MAX_MEMORY_GROWTH_MB).toBe(512);
  });

  it("takes other values, a memory growth limit of 0 (none), and refuses a stall time under 10 s", () => {
    const config = loadConfig({ FULL_OUTPUT_STALL_SECONDS: "60", FFMPEG_MAX_MEMORY_GROWTH_MB: "0" });
    expect(config.FULL_OUTPUT_STALL_SECONDS).toBe(60);
    expect(config.FFMPEG_MAX_MEMORY_GROWTH_MB).toBe(0);
    expect(() => loadConfig({ FULL_OUTPUT_STALL_SECONDS: "5" })).toThrow(/FULL_OUTPUT_STALL_SECONDS/);
    expect(() => loadConfig({ FFMPEG_MAX_MEMORY_GROWTH_MB: "-1" })).toThrow(/FFMPEG_MAX_MEMORY_GROWTH_MB/);
  });
});
