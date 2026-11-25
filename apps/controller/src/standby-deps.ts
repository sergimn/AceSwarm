/** What a stream's hot standbys need and are told (see `StreamStandbys` in `standby.ts`, which uses them). */

import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient, EngineSession } from "./acestream.ts";
import type { NetgwClient, TranscoderClient } from "./clients.ts";
import type { EngineHandle, EngineManager } from "./engines.ts";
import type { ControllerMetrics } from "./metrics.ts";
import type { RecoveryPolicy } from "./recovery.ts";
import type { SharedEngines } from "./shared-engines.ts";
import type { OpenSession, StandbyEngine } from "./standby-engine.ts";
import type { MoveSlots } from "./stream-paths.ts";

export interface StandbySettings {
  /** How many other paths each stream keeps a standby on, best first; 0 means all of them. */
  maxPaths: number;
  /** A stream with a hot standby fails over after this long without new video. */
  failoverAfterMs: number;
  /**
   * A stream moves to its standby on the favourite path once that was hot for this long without a
   * break (see `StreamStandbys.takeStable`).
   */
  favouriteAfterMs: number;
  /** A standby whose session brought no data for this long starts again (its engine, or its session). */
  warmupMs: number;
  /** A standby is hot while its last data is at most this old. */
  hotWithinMs: number;
  /** A standby whose path went down stays this long, in case the path comes back. */
  downGraceMs: number;
  /** Waits between tries on a standby that keeps failing. */
  policy: RecoveryPolicy;
}

export const DEFAULT_STANDBY_SETTINGS: StandbySettings = {
  maxPaths: 0,
  failoverAfterMs: 8000,
  favouriteAfterMs: 20_000,
  warmupMs: 90_000,
  hotWithinMs: 10_000,
  downGraceMs: 120_000,
  policy: { baseDelayMs: 5000, maxDelayMs: 300_000 },
};

export interface StreamStandbysDeps {
  streamId: string;
  engines: EngineManager;
  ace: AcestreamClient;
  transcoder: TranscoderClient;
  netgw: NetgwClient;
  metrics: ControllerMetrics;
  logger: Logger;
  settings: StandbySettings;
  shared?: SharedEngines | undefined;
  /**
   * Limits how many standbys start at once (shared by every stream): each new one starts an engine,
   * or a session on a path's shared engine that may have to start first. No limit without it.
   */
  startSlots?: MoveSlots | undefined;
  /** A generation number no other engine of the stream has (see `StreamEngines`). */
  nextGeneration: () => number;
  now: () => number;
}

/** What the stream's supervisor knows on each check (see `StreamStandbys.maintain`). */
export interface StandbyContext {
  /** Hot standby is on. */
  enabled: boolean;
  /** Engine sharing is on: standbys are sessions on the other paths' shared engines. */
  sharing: boolean;
  /** The gateway's paths are known. Until then nothing changes but the transcoder's readers. */
  known: boolean;
  /** The path the stream plays on, which gets no standby. */
  current: string | null;
  /** The other paths the stream may use that are up, best first. */
  candidates: readonly string[];
  /**
   * The favourite path while the stream is to move there: it is one of the `candidates` (the first).
   * It gets a standby before the others, also when they fill `STANDBY_MAX_PATHS`. Undefined with no
   * favourite, and while the stream plays on it or may not move to it.
   */
  favourite?: string | undefined;
  /** Whether the stream may use the path at all: the gateway has it, and the policy allows it. */
  usable: (path: string) => boolean;
  up: (path: string) => boolean;
  /**
   * The stream played lately (see `StreamFailover`): only then do standbys start or start again.
   * Otherwise they go, since a broadcast that is off for hours would only make them churn.
   */
  active: boolean;
  /** The path of the engine the stream kept from a failed move, which gets no standby of its own. */
  sparePath: string | undefined;
  /**
   * The sources the transcoder reads: the one it plays from, and the one it still tries to hand
   * the stream over to. After a failover that gave up, that can be a standby's session, which the
   * transcoder may yet take (see `finishLateFailover`); its reader let go of it meanwhile.
   */
  transcoderSources: readonly string[];
  openSession: OpenSession;
}

/** A standby taken out for a failover; `StreamStandbys.restore` puts it back if the failover fails. */
export interface TakenStandby {
  path: string;
  engine: EngineHandle;
  session: EngineSession;
  hot: boolean;
  readonly standby: StandbyEngine;
}
