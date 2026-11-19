import type { PathStatus, StreamState, StreamView } from "@aceswarm/shared/api-types";
import {
  formatFreshness,
  formatPeers,
  formatSpeed,
  formatStandbys,
  pathLabel,
  shownState,
  STATE_LABELS,
} from "./format.ts";
import type { PageTime } from "./liveness.ts";

/** The player's live stats, one to a line in its stats window, in this order. */
export const PLAYER_STATS = {
  state: "State",
  "last-frame": "Last frame",
  peers: "Peers",
  speed: "Speed",
  path: "Path",
  standby: "Standby",
} as const;

export type PlayerStatKey = keyof typeof PLAYER_STATS;

/** The stats the player shows for a stream, by key: a stat that doesn't apply is left out. */
export type PlayerStatValues = Partial<Record<PlayerStatKey, string>>;

/**
 * What the stats window says, with the state it shows (its line takes the state's colour). A
 * disabled stream has no engine: no peers, no speed, no path. A stream without a standby leaves
 * that line out.
 */
export function playerStats(
  stream: StreamView,
  paths: readonly PathStatus[],
  time: Pick<PageTime, "now" | "stale">,
): { state: StreamState; values: PlayerStatValues } {
  const state = shownState(stream);
  // A page that hears nothing doesn't know that the stream still plays, so it doesn't say "Now".
  const values: PlayerStatValues = {
    state: STATE_LABELS[state],
    "last-frame": formatFreshness(stream.lastFrameAt, time.now, state === "playing" && !time.stale),
  };
  if (state !== "stopped") {
    values.peers = formatPeers(stream.peers, state, stream.engine?.shared === true);
    values.speed = formatSpeed(stream.downloadKBps);
    values.path = pathLabel(stream.path, paths);
    if (stream.standbys.length > 0) {
      // One standby to a line, each with why it is not hot when the controller knows.
      values.standby = stream.standbys.map((standby) => formatStandbys([standby], paths)).join("\n");
    }
  }
  return { state, values };
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  left: number;
  top: number;
}

/**
 * Where `object-fit: contain` draws a picture of size `picture` in `box`: as large as fits, centred,
 * with black bars on the sides that are left. Without a picture to measure (none has loaded, or
 * none shows), the whole box counts as the picture.
 */
export function pictureRect(box: Size, picture: Size | null): Rect {
  if (picture === null || picture.width <= 0 || picture.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { left: 0, top: 0, width: Math.max(0, box.width), height: Math.max(0, box.height) };
  }
  // The side that fills the box is the box's own, exactly; the other one scales.
  const wider = picture.width * box.height > box.width * picture.height;
  const width = wider ? box.width : (picture.width * box.height) / picture.height;
  const height = wider ? (picture.height * box.width) / picture.width : box.height;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/**
 * Where the stats window's top goes: a quarter of the way down the picture. On a screen too short
 * for that, it moves up so that its bottom stays at `room.bottom` (above Back and Restart), but
 * never above `room.top` (under the title).
 */
export function statsTop(picture: Rect, height: number, room: { top: number; bottom: number }): number {
  return Math.max(room.top, Math.min(picture.top + picture.height / 4, room.bottom - height));
}

/** The padding around the message that says why there is no picture, as in the styles (`.player-waiting`). */
const WAITING_PADDING = 32;

/** The narrowest column beside the stats window that the message moves into. */
const WAITING_BESIDE = 160;

/** The space the message that says why there is no picture is centred in, as its padding. */
export interface WaitingRoom {
  top: number;
  bottom: number;
  /** Only when the message moves beside the window. */
  left?: number;
}

/**
 * Where the message that says why there is no picture goes while the stats window shows, measured
 * where it sits with no room made for it. Null when the message, centred on the screen, is clear of
 * the window and can stay there. Otherwise it moves between the window and the controls. When that
 * space is too small for it (a phone held sideways), it moves beside the window, where it wraps: a
 * line or two, like the controller's messages, fits there. Null too on a screen too small for
 * either, where the message stays in the middle.
 */
export function waitingRoom(
  screen: Size,
  message: { left: number; height: number },
  window: { top: number; right: number; bottom: number },
  controlsTop: number,
  gap: number,
): WaitingRoom | null {
  const below = window.bottom + gap;
  if (message.left >= window.right || (screen.height - message.height) / 2 >= below) {
    return null;
  }
  const above = controlsTop - gap;
  if (above - below >= message.height) {
    return { top: below, bottom: screen.height - above };
  }
  const beside = window.right + 2 * gap;
  return screen.width - WAITING_PADDING - beside >= WAITING_BESIDE
    ? { top: window.top, bottom: screen.height - above, left: beside }
    : null;
}
