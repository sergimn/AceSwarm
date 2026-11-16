import type { StandbyReaderStatus, StandbyView } from "@aceswarm/shared/api-types";
import type { StandbyEngine } from "./standby-engine.ts";

const REASON_MAX_LENGTH = 60;

/** A reason as the UI shows it: an error can be long, and the stream's tile is small (three lines of it). */
function brief(reason: string | null): string | null {
  return reason !== null && reason.length > REASON_MAX_LENGTH ? `${reason.slice(0, REASON_MAX_LENGTH - 1)}…` : reason;
}

/**
 * A reader's error without where the request was going. Node's errors for a connection that failed
 * end with the engine's address ("fetch failed (connect ECONNREFUSED 172.17.0.5:6878)"), which says
 * nothing to the person looking at the tile.
 */
function withoutAddresses(error: string): string {
  const cut = error
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replaceAll(/\bhttps?:\/\/\S+/g, "the engine")
    .replaceAll(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "the engine");
  return cut.length > 0 ? cut : "its reader failed";
}

/**
 * What a standby's reader says is wrong with its session: its error, or that the broadcast is stale.
 * The last answer's: it stays while the transcoder can't be reached.
 */
export function readerNote(reader: StandbyReaderStatus): string | undefined {
  if (reader.error !== null) {
    return withoutAddresses(reader.error);
  }
  return reader.liveEdge?.state === "stale" ? "its broadcast sends no new data" : undefined;
}

export function standbyView(standby: StandbyEngine, hotWithinMs: number): StandbyView {
  const state = standby.state(hotWithinMs);
  return {
    path: standby.path,
    state,
    engine: standby.engine === undefined ? null : { name: standby.engine.name, shared: standby.shared },
    reason: brief(standby.reason(state)),
  };
}

/** Why the standbys of a path failed, and when it may get a new one. */
export interface PathRetry {
  retryAt: number;
  reason: string;
}

/**
 * A path that lost its standbys and gets no new one yet: failed, without an engine, with why the
 * last one failed, and that the path was given up once it gets none until its status changes.
 */
function waitingView(path: string, retry: PathRetry): StandbyView {
  const given = retry.retryAt === Infinity;
  return {
    path,
    state: "failed",
    engine: null,
    reason: brief(given ? `gave up, ${retry.reason}` : retry.reason),
  };
}

/**
 * The paths among the candidates (`ranking`, best first) that have no standby but wait for one,
 * as many as there is room for: a path beyond the number of standbys kept isn't waiting for anything.
 */
export function waitingViews(
  retries: ReadonlyMap<string, PathRetry>,
  ranking: readonly string[],
  hasStandby: (path: string) => boolean,
  room: number,
): StandbyView[] {
  const views: StandbyView[] = [];
  for (const path of ranking) {
    const retry = retries.get(path);
    if (retry !== undefined && !hasStandby(path) && views.length < room) {
      views.push(waitingView(path, retry));
    }
  }
  return views;
}
