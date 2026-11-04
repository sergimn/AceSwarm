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
