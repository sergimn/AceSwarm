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
