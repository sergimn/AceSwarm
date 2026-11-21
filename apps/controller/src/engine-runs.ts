import type { Logger } from "@aceswarm/shared/logger";
import type { ContainerDetails } from "./docker.ts";
import type { EnginePlace } from "./engine-places.ts";

/** Why the controller removed an engine of one stream. */
const OWN_REMOVALS = ["moved", "move-failed", "standby-removed", "sharing", "stopped", "leftover"] as const;
/** Why the controller removed an engine that the streams of a network path share. */
const SHARED_REMOVALS = ["replaced", "idle", "unresponsive", "leftover"] as const;
/** How an engine's process exited without the controller: the container runtime then starts it again. */
const EXITS = ["oom-killed", "exited"] as const;

/**
 * Why a run of an engine ended. A run is the time an engine's process ran: from its container's
 * start, or its last restart, until the engine is restarted or removed.
 *
 * Removed, an engine of one stream:
 * - moved: the stream plays from another engine now.
 * - move-failed: the new engine of a move that failed, at once or after it was kept to try again.
 * - standby-removed: a hot standby that failed, or that the stream no longer needs.
 * - sharing: the stream plays from its path's shared engine now.
 * - stopped: the stream was stopped, disabled or deleted.
 *
 * Removed, a shared engine:
 * - replaced: a new engine took its place.
 * - idle: no stream used it any more.
 * - unresponsive: it stopped answering.
 *
 * Removed, either kind:
 * - leftover: an engine nothing uses, such as one an earlier run of the controller left behind.
 *
 * Restarted in the container it has, an engine of one stream:
 * - restart: the controller restarted it: a recovery step, a restart by hand, or a standby that
 *   brought no data. (A shared engine is replaced instead.)
 *
 * Exited in the container it has, either kind; the container runtime starts the engine again,
 * unless someone stopped it:
 * - oom-killed: the kernel killed it for exceeding its memory limit.
 * - exited: it exited by itself, or was stopped or restarted from outside.
 */
export type EngineEndReason =
  (typeof OWN_REMOVALS)[number] | (typeof SHARED_REMOVALS)[number] | "restart" | (typeof EXITS)[number];

/** Whether an engine belongs to one stream, or to a network path whose streams share it. */
export type EngineKind = "own" | "shared";

/** The reasons a run of each kind of engine can end with, which the lifetime histogram starts at zero. */
export const ENGINE_END_REASONS: Readonly<Record<EngineKind, readonly EngineEndReason[]>> = {
  own: [...OWN_REMOVALS, "restart", ...EXITS],
  shared: [...SHARED_REMOVALS, ...EXITS],
};

/** What the log says happened to an engine whose run ended for this reason. */
function ending(reason: EngineEndReason): string {
  if (reason === "restart") {
    return "engine restarted";
  }
  return (EXITS as readonly string[]).includes(reason) ? "engine exited" : "engine removed";
}

/** The run of an engine that ends, as its container says. */
export interface EngineRun {
  containerId: string;
  /** Container name. */
  engine: string;
  /** The stream that owns the engine; empty for a shared engine. */
  stream: string;
  /** The network path of a shared engine; null for a stream's own engine. */
  sharedPath: string | null;
  /** When the run started (the container's `State.StartedAt`), which also tells its runs apart. */
  startedAt: string;
  /** When the run ended, in milliseconds since the epoch. */
  endedAt: number;
}

/**
 * The run of the engine in this container: until `now` while it runs, or else until it exited.
 * Undefined for a container that never started.
 */
export function engineRun(details: ContainerDetails, now: number): EngineRun | undefined {
  const started = Date.parse(details.State.StartedAt);
  // A container that never started says year 1.
  if (!(started > 0)) {
    return undefined;
  }
  const finished = Date.parse(details.State.FinishedAt);
  return {
    containerId: details.Id,
    engine: details.Name.replace(/^\//, ""),
    stream: details.Config.Labels["aceswarm.stream"] ?? "",
    sharedPath: details.Config.Labels["aceswarm.shared-path"] ?? null,
    startedAt: details.State.StartedAt,
    endedAt: details.State.Running || !(finished >= started) ? now : finished,
  };
}

export interface EngineRunsDeps {
  /** Counts a run of this length, in seconds, that ended for this reason. */
  observe: (kind: EngineKind, reason: EngineEndReason, seconds: number) => void;
  /** The place a stream's engine has or last had, by container name; undefined when it never had one. */
  placeOf: (engine: string) => EnginePlace | undefined;
  logger: Logger;
}

/**
 * Counts and logs every run of an engine that ends: how long it lasted, why it ended, and what the
 * engine was for. An engine's container name is new with every engine, so the count has the reason
 * and the kind of engine instead, and the log line has the rest: the stream, the engine's role and
 * its network path.
 *
 * Two parts of the controller see a run end. The engine manager ends the ones the controller
 * restarts or removes itself, and knows why. The resource sampler sees every container whose
 * process exited since its last look, which includes those. A run only counts once: the first to
 * tell wins, and the engine manager claims a run before it acts (see `ending`).
 */
export class EngineRuns {
  private readonly deps: EngineRunsDeps;
  private readonly logger: Logger;
  /** The start of the last run that ended or is about to, per container id. */
  private readonly ended = new Map<string, string>();

  constructor(deps: EngineRunsDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: "engines" });
  }

  /** The run ended for this reason; `detail` says more in the log. Does nothing when it was told before. */
  end(run: EngineRun, reason: EngineEndReason, detail?: string): void {
    this.ending(run)(reason, detail);
  }

  /**
   * The controller is about to end the run itself, by restarting or removing the container. From
   * now on the run counts as told, so the sampler doesn't report the exit it sees meanwhile as one
   * the engine made by itself. Call the returned function with the reason once the container is
   * restarted or removed, or without one when that failed and the engine runs on.
   */
  ending(run: EngineRun): (reason?: EngineEndReason, detail?: string) => void {
    if (this.ended.get(run.containerId) === run.startedAt) {
      return () => undefined;
    }
    this.ended.set(run.containerId, run.startedAt);
    return (reason, detail) => {
      if (reason !== undefined) {
        this.tell(run, reason, detail);
      } else if (this.ended.get(run.containerId) === run.startedAt) {
        this.ended.delete(run.containerId);
      }
    };
  }

  /** Forgets the containers that are gone: `containerIds` are the engine containers there are. */
  keep(containerIds: ReadonlySet<string>): void {
    for (const id of this.ended.keys()) {
      if (!containerIds.has(id)) {
        this.ended.delete(id);
      }
    }
  }

  private tell(run: EngineRun, reason: EngineEndReason, detail: string | undefined): void {
    const kind: EngineKind = run.sharedPath === null ? "own" : "shared";
    const lifetimeSeconds = Math.max(0, Math.round((run.endedAt - Date.parse(run.startedAt)) / 1000));
    this.deps.observe(kind, reason, lifetimeSeconds);
    const place: EnginePlace | undefined =
      run.sharedPath === null ? this.deps.placeOf(run.engine) : { role: "shared", path: run.sharedPath };
    this.logger.info(
      {
        engine: run.engine,
        stream: run.stream,
        kind,
        role: place?.role ?? "",
        path: place?.path ?? "",
        reason,
        ...(detail !== undefined && { detail }),
        lifetimeSeconds,
      },
      ending(reason),
    );
  }
}
