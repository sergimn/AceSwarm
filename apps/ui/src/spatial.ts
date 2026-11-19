/**
 * Spatial navigation for TV remotes: given the focused element's box and the boxes of every
 * focusable element, picks the closest one in the pressed direction.
 */

export type Direction = "up" | "down" | "left" | "right";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Pixels of slack when comparing positions: browsers report boxes with rounding noise. */
const EPSILON = 1;
/** How much more a sideways offset costs than distance along the direction. */
const ORTHOGONAL_WEIGHT = 2;

function overlapGap(startA: number, endA: number, startB: number, endB: number): number {
  if (endA < startB) {
    return startB - endA;
  }
  if (endB < startA) {
    return startA - endB;
  }
  return 0;
}

/**
 * Whether the span `to` lies ahead of the span `from` along an axis, forwards (right, down) or
 * backwards (left, up): clear of it, or overlapping it with its centre further along.
 *
 * The centre has to be further along by more than the slack. The focused tile is drawn scaled
 * around its centre, and the browser reports the scaled box with rounding noise: the tile below it
 * then has its centre a hair to the left or right of the focused one's, and the tile beside it a
 * hair above or below. Without the slack, Left could land on the tile below instead of the rail,
 * or Down on the tile beside instead of the footer.
 */
function isAhead(fromStart: number, fromEnd: number, toStart: number, toEnd: number, forwards: boolean): boolean {
  const centreShift = (toStart + toEnd) / 2 - (fromStart + fromEnd) / 2;
  return forwards
    ? toStart >= fromEnd - EPSILON || centreShift > EPSILON
    : toEnd <= fromStart + EPSILON || centreShift < -EPSILON;
}

/** Distance score of `to` from `from` in a direction, or undefined when it is not in that direction. */
export function directionalDistance(from: Box, to: Box, direction: Direction): number | undefined {
  let primary: number;
  let secondary: number;
  switch (direction) {
    case "right": {
      if (!isAhead(from.left, from.right, to.left, to.right, true)) {
        return undefined;
      }
      primary = Math.max(0, to.left - from.right);
      secondary = overlapGap(from.top, from.bottom, to.top, to.bottom);
      break;
    }
    case "left": {
      if (!isAhead(from.left, from.right, to.left, to.right, false)) {
        return undefined;
      }
      primary = Math.max(0, from.left - to.right);
      secondary = overlapGap(from.top, from.bottom, to.top, to.bottom);
      break;
    }
    case "down": {
      if (!isAhead(from.top, from.bottom, to.top, to.bottom, true)) {
        return undefined;
      }
      primary = Math.max(0, to.top - from.bottom);
      secondary = overlapGap(from.left, from.right, to.left, to.right);
      break;
    }
    case "up": {
      if (!isAhead(from.top, from.bottom, to.top, to.bottom, false)) {
        return undefined;
      }
      primary = Math.max(0, from.top - to.bottom);
      secondary = overlapGap(from.left, from.right, to.left, to.right);
      break;
    }
  }
  return primary + secondary * ORTHOGONAL_WEIGHT;
}

/** Index of the best candidate in the direction, or -1 when there is none. */
export function pickNext(from: Box, candidates: readonly Box[], direction: Direction): number {
  let best = -1;
  let bestScore = Infinity;
  for (const [index, candidate] of candidates.entries()) {
    const score = directionalDistance(from, candidate, direction);
    if (score !== undefined && score < bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

const KEY_DIRECTIONS: Record<string, Direction | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
};

export function keyDirection(key: string): Direction | undefined {
  return KEY_DIRECTIONS[key];
}

/** Keys that mean "back" on TV remotes, browsers and set-top boxes. */
const BACK_KEYS = new Set(["Escape", "Esc", "GoBack", "BrowserBack", "Back", "XF86Back"]);
/** Legacy key codes: Android WebView back (4), Tizen (10009) and webOS (461). */
const BACK_KEY_CODES = new Set([4, 10_009, 461]);

export function isBackKey(key: string, keyCode: number): boolean {
  return BACK_KEYS.has(key) || BACK_KEY_CODES.has(keyCode);
}
