import { keyDirection } from "./spatial.ts";

/**
 * Whether the person points (a mouse, a touch screen) or presses keys (a TV remote, a keyboard).
 * With a pointer, the tile under it shows its details; with keys, the focused tile does (see the
 * tile styles). Either way, only one tile shows them. Focus stays where it is when the mode
 * changes: after a stream opened with a click is closed, its tile keeps focus but shows nothing,
 * until a key shows it again.
 */
export type InputMode = "pointer" | "keys";

/**
 * What a key press says about the mode: the keys that move focus or act on it mean keys. Back and
 * Escape close what is open, whatever opened it, and leave the mode as it is.
 */
export function modeAfterKey(key: string, withModifier: boolean): InputMode | undefined {
  if (withModifier) {
    return undefined;
  }
  return keyDirection(key) !== undefined || ["Enter", " ", "Tab"].includes(key) ? "keys" : undefined;
}

/**
 * Whether a key only shows where focus is. With a pointer, the focused tile looks like the others,
 * so the first key that would move from it or open it shows it instead, as the player's first key
 * only shows its overlay: Enter would otherwise open a tile other than the one under the mouse.
 * Tab moves focus on, as everywhere else on the page.
 */
export function keyOnlyShowsFocus(mode: InputMode, key: string, focusHidden: boolean): boolean {
  return mode === "pointer" && focusHidden && key !== "Tab" && modeAfterKey(key, false) === "keys";
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Whether a pointer move is one the person made. Chromium also reports moves with no hand on the
 * mouse, where the pointer already is: one when the page loads under it, for example, which would
 * otherwise hide the focus a remote needs from the start. So the first move only says where the
 * pointer is.
 */
export function pointerMoved(last: ScreenPoint | undefined, next: ScreenPoint): boolean {
  return last !== undefined && (last.x !== next.x || last.y !== next.y);
}

/**
 * Keeps the mode in `data-input` on `root`: "keys" until the pointer is used. `hidesFocus` matches
 * the elements whose focus doesn't show with a pointer.
 */
export function trackInputMode(hidesFocus: string, root: HTMLElement = document.body): void {
  let mode: InputMode = "keys";
  let last: ScreenPoint | undefined;
  const set = (next: InputMode): void => {
    mode = next;
    if (root.dataset["input"] !== next) {
      root.dataset["input"] = next;
    }
  };
  set("keys");
  // In the capture phase on the window, so that it runs before the page's own key handlers, which
  // leave alone a key it took.
  addEventListener(
    "keydown",
    (event) => {
      const next = modeAfterKey(event.key, event.altKey || event.ctrlKey || event.metaKey);
      if (next === undefined) {
        return;
      }
      const focused = document.activeElement;
      if (keyOnlyShowsFocus(mode, event.key, focused instanceof Element && focused.matches(hidesFocus))) {
        event.preventDefault();
      }
      set(next);
    },
    true,
  );
  addEventListener(
    "pointermove",
    (event) => {
      const point = { x: event.screenX, y: event.screenY };
      if (pointerMoved(last, point)) {
        set("pointer");
      }
      last = point;
    },
    true,
  );
  addEventListener(
    "pointerdown",
    (event) => {
      last = { x: event.screenX, y: event.screenY };
      set("pointer");
    },
    true,
  );
}
