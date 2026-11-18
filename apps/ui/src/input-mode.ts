import { keyDirection } from "./spatial.ts";

/**
 * Whether the person points (a mouse, a touch screen) or presses keys (a TV remote, a keyboard).
 * With a pointer, the tile under it shows its details; with keys, the focused tile does (see the
 * tile styles). Either way, only one tile shows them. Focus stays where it is when the mode
 * changes: after a stream opened with a click is closed, its tile keeps focus but shows nothing,
 * and the keys go on from it.
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
  return keyDirection(key) !== undefined || key === "Enter" || key === "Tab" ? "keys" : undefined;
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

/** Keeps the mode in `data-input` on `root`: "keys" until the pointer is used. */
export function trackInputMode(root: HTMLElement = document.body): void {
  let last: ScreenPoint | undefined;
  const set = (mode: InputMode): void => {
    if (root.dataset["input"] !== mode) {
      root.dataset["input"] = mode;
    }
  };
  set("keys");
  // In the capture phase, since the player and the dialogs stop some keys themselves.
  addEventListener(
    "keydown",
    (event) => {
      const mode = modeAfterKey(event.key, event.altKey || event.ctrlKey || event.metaKey);
      if (mode !== undefined) {
        set(mode);
      }
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
