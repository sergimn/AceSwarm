import { describe, expect, it } from "vitest";
import {
  effectivePreviewMode,
  loadPreviewChoice,
  savePreviewChoice,
  THUMBNAILS_ONLY_TIP,
} from "../src/preview-mode.ts";

/** A browser's storage, as a map. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    storage: () => ({
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    }),
  };
}

/** A browser that keeps nothing: reading its storage throws. */
const noStorage = (): never => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

describe("the browser's tile previews choice", () => {
  it("is Live video until the browser chose otherwise", () => {
    expect(loadPreviewChoice(memoryStorage().storage)).toBe("video");
    expect(loadPreviewChoice(memoryStorage({ "aceswarm.previewMode": "thumbnails" }).storage)).toBe("thumbnails");
    expect(loadPreviewChoice(memoryStorage({ "aceswarm.previewMode": "video" }).storage)).toBe("video");
    expect(loadPreviewChoice(memoryStorage({ "aceswarm.previewMode": "anything" }).storage)).toBe("video");
  });

  it("is kept in the browser, under the key earlier versions used", () => {
    const { items, storage } = memoryStorage();
    savePreviewChoice("thumbnails", storage);
    expect(items.get("aceswarm.previewMode")).toBe("thumbnails");
    expect(loadPreviewChoice(storage)).toBe("thumbnails");
  });

  it("lasts the visit where the browser keeps nothing", () => {
    expect(loadPreviewChoice(noStorage)).toBe("video");
    expect(() => {
      savePreviewChoice("thumbnails", noStorage);
    }).not.toThrow();
  });
});

describe("what the tiles show", () => {
  it("follows the browser's choice while the admin allows both", () => {
    expect(effectivePreviewMode("video", false)).toBe("video");
    expect(effectivePreviewMode("thumbnails", false)).toBe("thumbnails");
  });

  it("is thumbnails only while the admin allows nothing else, whatever the browser chose", () => {
    expect(effectivePreviewMode("video", true)).toBe("thumbnails");
    expect(effectivePreviewMode("thumbnails", true)).toBe("thumbnails");
  });

  it("explains a greyed out Live video in the admin's words", () => {
    expect(THUMBNAILS_ONLY_TIP).toBe(
      "Your admin has restricted this feature to save resources. Contact them for any questions",
    );
  });
});
