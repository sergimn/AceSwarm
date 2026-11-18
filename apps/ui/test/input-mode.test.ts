import { describe, expect, it } from "vitest";
import { keyOnlyShowsFocus, modeAfterKey, pointerMoved } from "../src/input-mode.ts";

describe("modeAfterKey", () => {
  it("means keys for the keys that move focus or act on it", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Up", "Left", "Enter", " ", "Tab"]) {
      expect(modeAfterKey(key, false)).toBe("keys");
    }
  });

  it("leaves the mode to Back and Escape, which close what is open whatever opened it", () => {
    for (const key of ["Escape", "Esc", "GoBack", "BrowserBack", "Backspace"]) {
      expect(modeAfterKey(key, false)).toBeUndefined();
    }
  });

  it("leaves it to typing and shortcuts", () => {
    expect(modeAfterKey("a", false)).toBeUndefined();
    expect(modeAfterKey("Shift", false)).toBeUndefined();
    expect(modeAfterKey("AudioVolumeUp", false)).toBeUndefined();
    // Ctrl+Tab and Alt+Left are the browser's.
    expect(modeAfterKey("Tab", true)).toBeUndefined();
    expect(modeAfterKey("ArrowLeft", true)).toBeUndefined();
  });
});

describe("keyOnlyShowsFocus", () => {
  it("shows a focused tile that the pointer hid, instead of moving from it or opening it", () => {
    for (const key of ["ArrowLeft", "ArrowDown", "Enter", " "]) {
      expect(keyOnlyShowsFocus("pointer", key, true)).toBe(true);
    }
  });

  it("lets Tab move on, as everywhere else", () => {
    expect(keyOnlyShowsFocus("pointer", "Tab", true)).toBe(false);
  });

  it("acts at once where focus shows: with keys, or on an element that always shows it", () => {
    expect(keyOnlyShowsFocus("keys", "ArrowLeft", true)).toBe(false);
    expect(keyOnlyShowsFocus("keys", "Enter", true)).toBe(false);
    expect(keyOnlyShowsFocus("pointer", "Enter", false)).toBe(false);
  });

  it("leaves the keys that don't mean keys alone", () => {
    expect(keyOnlyShowsFocus("pointer", "Escape", true)).toBe(false);
    expect(keyOnlyShowsFocus("pointer", "a", true)).toBe(false);
  });
});

describe("pointerMoved", () => {
  it("counts a move to another place", () => {
    expect(pointerMoved({ x: 10, y: 10 }, { x: 11, y: 10 })).toBe(true);
    expect(pointerMoved({ x: 10, y: 10 }, { x: 10, y: 9 })).toBe(true);
  });

  it("ignores a move reported where the pointer already was", () => {
    expect(pointerMoved({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
  });

  it("only learns where the pointer is from the first move", () => {
    expect(pointerMoved(undefined, { x: 0, y: 0 })).toBe(false);
  });
});
