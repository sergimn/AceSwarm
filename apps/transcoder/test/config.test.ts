import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("tile previews", () => {
  it("makes live previews unless the admin allows thumbnails only", () => {
    expect(loadConfig({}).PREVIEW_THUMBNAILS_ONLY).toBe(false);
    // compose.yaml passes "false" while the line in .env stays commented out.
    expect(loadConfig({ PREVIEW_THUMBNAILS_ONLY: "false" }).PREVIEW_THUMBNAILS_ONLY).toBe(false);
    expect(loadConfig({ PREVIEW_THUMBNAILS_ONLY: "true" }).PREVIEW_THUMBNAILS_ONLY).toBe(true);
  });
});
