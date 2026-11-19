import { describe, expect, it } from "vitest";
import { directionalDistance, isBackKey, keyDirection, pickNext, type Box } from "../src/spatial.ts";

function box(column: number, row: number): Box {
  // A 3 column grid of 100x60 tiles with 20px gaps.
  const left = column * 120;
  const top = row * 80;
  return { left, top, right: left + 100, bottom: top + 60 };
}

const grid = [box(0, 0), box(1, 0), box(2, 0), box(0, 1), box(1, 1)];

describe("pickNext", () => {
  it("moves to the neighbour in each direction", () => {
    const from = grid[1]!;
    expect(pickNext(from, grid, "left")).toBe(0);
    expect(pickNext(from, grid, "right")).toBe(2);
    expect(pickNext(from, grid, "down")).toBe(4);
    expect(pickNext(grid[4]!, grid, "up")).toBe(1);
  });

  it("returns -1 at the edges", () => {
    expect(pickNext(grid[0]!, grid, "left")).toBe(-1);
    expect(pickNext(grid[0]!, grid, "up")).toBe(-1);
  });

  it("prefers the aligned tile over a closer diagonal one", () => {
    // From the last tile of the first row, "down" has no tile right below; it picks the nearest.
    expect(pickNext(grid[2]!, grid, "down")).toBe(4);
    const rail: Box = { left: -80, top: 100, right: -20, bottom: 140 };
    expect(pickNext(rail, grid, "right")).toBe(3);
  });

  it("ignores elements behind the focused one", () => {
    expect(directionalDistance(grid[1]!, grid[0]!, "right")).toBeUndefined();
    expect(directionalDistance(grid[1]!, grid[2]!, "right")).toBe(20);
  });

  it("takes an element that overlaps the focused one when its centre is clearly further along", () => {
    const wide: Box = { left: 0, top: 0, right: 100, bottom: 60 };
    const offset: Box = { left: 50, top: 80, right: 150, bottom: 140 };
    expect(directionalDistance(wide, offset, "right")).toBe(40);
    expect(directionalDistance(offset, wide, "left")).toBe(40);
    expect(directionalDistance(wide, offset, "left")).toBeUndefined();
  });
});

/** How much the focused tile is scaled (styles.css). */
const FOCUS_SCALE = 1.03;

/** The box of `tile` scaled around its centre, as the browser reports it, with `noise` px of rounding. */
function focusedBox(tile: Box, noise: number): Box {
  const halfWidth = ((tile.right - tile.left) * FOCUS_SCALE) / 2;
  const halfHeight = ((tile.bottom - tile.top) * FOCUS_SCALE) / 2;
  const centreX = (tile.left + tile.right) / 2 + noise;
  const centreY = (tile.top + tile.bottom) / 2 + noise;
  return {
    left: centreX - halfWidth,
    top: centreY - halfHeight,
    right: centreX + halfWidth,
    bottom: centreY + halfHeight,
  };
}

describe("a focused tile drawn scaled", () => {
  it("goes Left to the rail, not to the tile below it (boxes measured in Chromium)", () => {
    // The first tile mid-way through its focus transition, the tile below it in the same column,
    // and the rail's top button: the tile's centre is 1.5e-5 px right of the one below.
    const focused: Box = { left: 130.34584, top: 79.571503, right: 397.12294, bottom: 229.63162 };
    const below: Box = { left: 131.71875, top: 249.328125, right: 395.75, bottom: 397.84375 };
    const railButton: Box = { left: 12, top: 84, right: 88, bottom: 143.53125 };
    expect(directionalDistance(focused, below, "left")).toBeUndefined();
    expect(pickNext(focused, [below, railButton], "left")).toBe(1);
  });

  it("never counts the tile in its own column as beside it, or the one in its own row as above or below it", () => {
    for (const noise of [-0.5, -1e-5, 0, 1e-5, 0.5]) {
      // grid[0] focused, with grid[3] below it and grid[1] beside it.
      const focused = focusedBox(grid[0]!, noise);
      expect(directionalDistance(focused, grid[3]!, "left")).toBeUndefined();
      expect(directionalDistance(focused, grid[3]!, "right")).toBeUndefined();
      expect(directionalDistance(focused, grid[1]!, "up")).toBeUndefined();
      expect(directionalDistance(focused, grid[1]!, "down")).toBeUndefined();
      // What is really there is still found.
      expect(pickNext(focused, grid, "right")).toBe(1);
      expect(pickNext(focused, grid, "down")).toBe(3);
      // The last tile of the first row has nothing below it in its column: Down takes the nearest
      // tile of the next row, never the tile beside it.
      expect(pickNext(focusedBox(grid[2]!, noise), grid, "down")).toBe(4);
    }
  });
});

describe("keys", () => {
  it("maps arrows and legacy names", () => {
    expect(keyDirection("ArrowUp")).toBe("up");
    expect(keyDirection("Right")).toBe("right");
    expect(keyDirection("Enter")).toBeUndefined();
  });

  it("recognizes back keys from TVs and browsers", () => {
    expect(isBackKey("Escape", 27)).toBe(true);
    expect(isBackKey("GoBack", 0)).toBe(true);
    expect(isBackKey("Unidentified", 4)).toBe(true);
    expect(isBackKey("Unidentified", 10_009)).toBe(true);
    expect(isBackKey("Unidentified", 461)).toBe(true);
    expect(isBackKey("Backspace", 8)).toBe(false);
  });
});
