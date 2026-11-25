import type { SharedEnginesView } from "@aceswarm/shared/api-types";
import type { FavouriteOption } from "./paths.ts";

/**
 * What the "One engine per path" switch says. The cases that replace a shared engine are the ones
 * in `SharedEngines.restartReason` and its callers: a watched stream failing, too many streams
 * failing, every stream on it failing, the engine not answering, and a manual Restart.
 */
export function sharedEnginesHint(view: SharedEnginesView | undefined): string {
  if (view?.enabled !== true) {
    return "Off: every stream has an engine of its own.";
  }
  return [
    "On: streams on the same network path share one engine, which needs much less memory.",
    "The engine is replaced when a stream someone is watching fails,",
    `when more than ${String(view.maxFailures)} of its streams fail within ${String(view.failureWindowSeconds)} s,`,
    "when every stream on it fails, when it stops answering, or when you press Restart on one of its streams.",
    "A stream's connected peers are its own, but the peers sending data and their countries are the engine's:",
    "every stream on it shows the same.",
  ].join(" ");
}

export interface FavouritePathHint {
  text: string;
  /** Nothing moves to the favourite as things are: the hint shows as a warning. */
  caution: boolean;
}

/**
 * What the "Favourite path" setting says: what the chosen path does, or why no stream moves to it
 * now. `stableSeconds` is how long a stream's standby there has to be hot first.
 */
export function favouritePathHint(
  chosen: Pick<FavouriteOption, "id" | "label" | "unavailable"> | undefined,
  stableSeconds: number,
  hotStandby: boolean,
): FavouritePathHint {
  if (chosen === undefined || chosen.id === null) {
    return { text: "None: a stream stays on its path until that fails.", caution: false };
  }
  const { label, unavailable } = chosen;
  if (unavailable === "off") {
    return { text: `${label} is off while WireGuard only is on: streams stay where they are.`, caution: true };
  }
  if (unavailable === "down") {
    return { text: `${label} is down: streams stay where they are, and move to it once it is back.`, caution: true };
  }
  if (unavailable === "unknown") {
    const text = `The network gateway doesn't report ${label}: streams stay where they are until it does.`;
    return { text, caution: true };
  }
  if (!hotStandby) {
    const text = `${label}: new streams start on it. Hot standby is off, so no other stream moves to it by itself.`;
    return { text, caution: true };
  }
  return {
    text: [
      `${label}: a stream on another path moves to it once its standby there was hot for`,
      `${String(stableSeconds)} s without a break, and keeps its picture while it moves. New streams start on it.`,
    ].join(" "),
    caution: false,
  };
}
