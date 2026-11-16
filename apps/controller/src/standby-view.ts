import type { StandbyReaderStatus, StandbyView } from "@aceswarm/shared/api-types";
import type { StandbyEngine } from "./standby-engine.ts";

const REASON_MAX_LENGTH = 60;

/** A reason as the UI shows it: an error can be long, and the stream's tile is small (three lines of it). */
function brief(reason: string | null): string | null {
  return reason !== null && reason.length > REASON_MAX_LENGTH ? `${reason.slice(0, REASON_MAX_LENGTH - 1)}…` : reason;
}

/** What a standby's reader says is wrong with its session: its error, or that the broadcast is stale. */
export function readerNote(reader: StandbyReaderStatus): string | undefined {
  if (reader.error !== null) {
    return reader.error;
  }
  return reader.liveEdge?.state === "stale" ? "its broadcast sends no new data" : undefined;
}

export function standbyView(standby: StandbyEngine, hotWithinMs: number): StandbyView {
  return {
    path: standby.path,
    state: standby.state(hotWithinMs),
    engine: standby.engine === undefined ? null : { name: standby.engine.name, shared: standby.shared },
    reason: brief(standby.reason(hotWithinMs)),
  };
}

/**
 * A path that lost its standbys and gets no new one yet: failed, without an engine, with why the
 * last one failed, and that the path was given up once it gets none until its status changes.
 */
export function waitingView(path: string, retry: { retryAt: number; reason: string }): StandbyView {
  const given = retry.retryAt === Infinity;
  return {
    path,
    state: "failed",
    engine: null,
    reason: brief(given ? `gave up, ${retry.reason}` : retry.reason),
  };
}
