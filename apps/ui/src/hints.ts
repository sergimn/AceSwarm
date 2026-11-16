import type { SharedEnginesView } from "@aceswarm/shared/api-types";

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
    "when every stream on it fails, when it stops answering, or when you press Restart.",
    "A stream's connected peers are its own, but the peers sending data and their countries are the engine's:",
    "every stream on it shows the same.",
  ].join(" ");
}
