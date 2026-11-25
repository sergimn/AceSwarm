import type { PathStatus, PathStrategyName } from "@aceswarm/shared/api-types";
import type { StreamEnginesDeps } from "./stream-engines.ts";

export interface SupervisorSettings {
  tickMs: number;
  stallAfterMs: number;
  startupGraceMs: number;
  recoveryBaseDelayMs: number;
  recoveryMaxDelayMs: number;
  /**
   * The first wait between tries while the broadcast sends nothing new (stale source); it doubles
   * up to `recoveryMaxDelayMs`. 30 s when not given.
   */
  staleSourceRetryMs?: number;
  handoverTimeoutMs: number;
  pathStrategy: PathStrategyName;
  pathMinDwellMs: number;
}

/** What a supervisor needs: its stream's engines' needs (see `StreamEngines`), and these. */
export interface SupervisorDeps extends StreamEnginesDeps {
  settings: SupervisorSettings;
  /** Latest network path status from the gateway (empty when it is unreachable). */
  paths: () => PathStatus[];
  /** Whether the network policy lets engines use a path (the direct path is off with WireGuard only). */
  pathAllowed?: (path: string) => boolean;
  /** Number of running streams per path. */
  pathLoad: () => ReadonlyMap<string, number>;
  /** Whether streams share one engine per path (the setting can change at any time). */
  sharedEngines?: () => boolean;
  /** Whether streams keep hot standbys on the other paths (the setting can change at any time). */
  hotStandby?: () => boolean;
  /** The favourite path, or null for none (the setting can change at any time). */
  favouritePath?: () => string | null;
  /** Number of players showing this stream full screen. */
  viewers?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
