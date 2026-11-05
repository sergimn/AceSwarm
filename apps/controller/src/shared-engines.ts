import type { PathAssignment } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { NetgwClient } from "./clients.ts";
import type { EngineHandle, EngineManager } from "./engines.ts";
import type { ControllerMetrics } from "./metrics.ts";

export interface SharedEngineSettings {
  /** A shared engine restarts once more than this many of its streams failed within the window. */
  maxFailures: number;
  failureWindowMs: number;
  /** A replaced engine is removed after this long, even if a stream did not manage to leave it. */
  retireTimeoutMs: number;
  /** A path's engine that no stream uses any more is removed after this long. */
  idleTimeoutMs: number;
}

/** Why a shared engine was replaced. */
export type SharedRestartReason = "watched" | "failures" | "all-failed" | "manual";

export interface FailureReport {
  /** Someone watches the stream full screen. */
  watched: boolean;
  /** The stream's recovery ladder reached the step where it would restart its own engine. */
  wantsRestart: boolean;
}

/** One shared engine, for the metrics. */
export interface SharedEngineView {
  path: string;
  engine: string;
  streams: number;
  /** It was replaced and its streams are moving to the new one. */
  retiring: boolean;
}

interface Instance {
  path: string;
  /** Set once the engine's API answers. */
  handle: EngineHandle | undefined;
  ready: Promise<EngineHandle>;
  /** The address the gateway routes through the path. */
  ip: string | undefined;
  /** Streams with a session on this engine (or opening one). */
  readonly users: Set<string>;
  /** Last failure of each stream on this engine. */
  readonly failures: Map<string, number>;
  /** When the last stream left it (or when it became ready without one). */
  idleSince: number | undefined;
  retiring: boolean;
  retireTimer: NodeJS.Timeout | undefined;
}

export interface SharedEnginesDeps {
  engines: EngineManager;
  netgw: NetgwClient;
  metrics: ControllerMetrics;
  logger: Logger;
  settings: SharedEngineSettings;
  now?: () => number;
}

/**
 * One engine per network path that every stream on that path shares, which needs far less memory
 * than an engine per stream. An engine plays several streams at once, one session each.
 *
 * Restarting a shared engine would interrupt every stream on it, so the streams' own recovery only
 * restarts their sessions. The engine is replaced only when the stream someone is watching fails,
 * when more than `maxFailures` of its streams fail within `failureWindowMs`, or when every stream
 * on it reached the point where it would restart its own engine. Replacing is make-before-break: a
 * new engine starts on the same path, each stream moves over (handing its picture over once the new
 * engine delivers video), and the old engine goes once its last stream left.
 */
export class SharedEngines {
  private readonly deps: SharedEnginesDeps;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** The engine new sessions go to, per path. */
  private readonly current = new Map<string, Instance>();
  /** Replaced engines whose streams are still moving away. */
  private readonly retiring = new Set<Instance>();
  /** Paths whose engine is being replaced. */
  private readonly replacing = new Set<string>();
  /** No replacement before this time, per path (after one that failed to start). */
  private readonly blockedUntil = new Map<string, number>();
  /** Highest engine generation seen per path. */
  private readonly generations = new Map<string, number>();
  private lastOrphanSweep = -Infinity;

  constructor(deps: SharedEnginesDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: "shared-engines" });
    this.now = deps.now ?? Date.now;
  }

  /**
   * The path's engine for a stream: the running one, the one left from a previous run, or a new one.
   * Waits until its API answers. The stream holds it until it calls `release`.
   */
  async acquire(path: string, streamId: string): Promise<EngineHandle> {
    const instance = this.current.get(path) ?? this.start(path, true);
    instance.users.add(streamId);
    instance.idleSince = undefined;
    try {
      return await instance.ready;
    } catch (error) {
      instance.users.delete(streamId);
      throw error;
    }
  }

  /** The stream left the engine. An engine without streams is removed. */
  async release(handle: EngineHandle, streamId: string): Promise<void> {
    const instance = this.find(handle);
    if (instance === undefined) {
      return;
    }
    instance.users.delete(streamId);
    instance.failures.delete(streamId);
    if (instance.users.size === 0 && instance.handle !== undefined) {
      await this.remove(instance, "no streams left on it");
    }
  }

  get settings(): SharedEngineSettings {
    return this.deps.settings;
  }

  /** Whether new sessions on the engine's path go to this engine; false once it was replaced. */
  isCurrent(handle: EngineHandle): boolean {
    const current = handle.sharedPath === null ? undefined : this.current.get(handle.sharedPath);
    return current?.handle?.containerId === handle.containerId;
  }

  /**
   * A stream on the engine failed and its recovery is acting. Returns true when the engine is being
   * replaced, by this report or an earlier one.
   */
  reportFailure(handle: EngineHandle, streamId: string, report: FailureReport): boolean {
    const instance = this.find(handle);
    if (instance === undefined || instance.retiring) {
      // Already replaced: the stream moves to the new engine.
      return instance !== undefined;
    }
    const now = this.now();
    instance.failures.set(streamId, now);
    for (const [stream, at] of instance.failures) {
      if (now - at > this.deps.settings.failureWindowMs || !instance.users.has(stream)) {
        instance.failures.delete(stream);
      }
    }
    let reason: SharedRestartReason | undefined;
    if (report.watched) {
      reason = "watched";
    } else if (instance.failures.size > this.deps.settings.maxFailures) {
      reason = "failures";
    } else if (report.wantsRestart && [...instance.users].every((stream) => instance.failures.has(stream))) {
      reason = "all-failed";
    }
    if (reason === undefined) {
      this.logger.info(
        { path: instance.path, stream: streamId, failing: instance.failures.size, streams: instance.users.size },
        "a stream on the shared engine failed; keeping the engine",
      );
      return this.replacing.has(instance.path);
    }
    return this.replace(instance, reason);
  }

  /** Replaces the engine because someone asked for it (a manual restart). */
  restart(handle: EngineHandle): boolean {
    const instance = this.find(handle);
    return instance !== undefined && !instance.retiring && this.replace(instance, "manual");
  }

  /** The gateway paths of every shared engine, by engine address (re-sent periodically). */
  assignments(): PathAssignment[] {
    const assignments: PathAssignment[] = [];
    for (const instance of [...this.current.values(), ...this.retiring]) {
      if (instance.ip !== undefined) {
        assignments.push({ ip: instance.ip, path: instance.path });
      }
    }
    return assignments;
  }

  view(): SharedEngineView[] {
    return [...this.current.values(), ...this.retiring]
      .filter((instance) => instance.handle !== undefined)
      .map((instance) => ({
        path: instance.path,
        engine: instance.handle?.name ?? "",
        streams: instance.users.size,
        retiring: instance.retiring,
      }));
  }

  /**
   * Removes shared engines nobody uses: a path's engine whose streams all left it a while ago, and
   * engines left from a previous run that no stream took over. Call it once every stream had the
   * chance to take its engine (the orchestrator does, after every stream's first start attempt).
   */
  async sweep(): Promise<void> {
    const now = this.now();
    // Removing an instance deletes it from the map, which iteration copes with.
    for (const instance of this.current.values()) {
      if (
        instance.handle !== undefined &&
        instance.users.size === 0 &&
        !this.replacing.has(instance.path) &&
        instance.idleSince !== undefined &&
        now - instance.idleSince >= this.deps.settings.idleTimeoutMs
      ) {
        await this.remove(instance, "no stream uses it");
      }
    }
    if (now - this.lastOrphanSweep < 60_000) {
      return;
    }
    this.lastOrphanSweep = now;
    const known = new Set<string>();
    const starting = new Set<string>();
    for (const instance of [...this.current.values(), ...this.retiring]) {
      if (instance.handle === undefined) {
        starting.add(instance.path);
      } else {
        known.add(instance.handle.containerId);
      }
    }
    for (const path of this.replacing) {
      starting.add(path);
    }
    const engines = await this.deps.engines.findShared();
    for (const handle of engines) {
      if (known.has(handle.containerId) || (handle.sharedPath !== null && starting.has(handle.sharedPath))) {
        continue;
      }
      this.logger.info({ engine: handle.name }, "removing a shared engine no stream uses");
      await this.deps.engines.remove(handle).catch((error: unknown) => {
        this.logger.warn({ err: error, engine: handle.name }, "could not remove a shared engine");
      });
    }
  }

  private find(handle: EngineHandle): Instance | undefined {
    for (const instance of [...this.current.values(), ...this.retiring]) {
      if (instance.handle?.containerId === handle.containerId) {
        return instance;
      }
    }
    return undefined;
  }

  /**
   * Starts an engine for the path. With `adopt`, it is the path's current engine right away and
   * takes over an engine left from a previous run; otherwise it is a replacement, which becomes
   * current once it answers.
   */
  private start(path: string, adopt: boolean): Instance {
    const { promise, resolve, reject } = Promise.withResolvers<EngineHandle>();
    const instance: Instance = {
      path,
      handle: undefined,
      ready: promise,
      ip: undefined,
      users: new Set(),
      failures: new Map(),
      idleSince: undefined,
      retiring: false,
      retireTimer: undefined,
    };
    this.launch(instance, adopt).then(resolve).catch(reject);
    instance.ready.catch((error: unknown) => {
      this.logger.warn({ err: error, path }, "shared engine did not start");
      if (this.current.get(path) === instance) {
        this.current.delete(path);
      }
      this.unroute(instance);
    });
    if (adopt) {
      this.current.set(path, instance);
    }
    return instance;
  }

  private async launch(instance: Instance, adopt: boolean): Promise<EngineHandle> {
    const { path } = instance;
    const onAddress = async (handle: EngineHandle): Promise<void> => {
      await this.route(instance, handle.ip);
    };
    let handle: EngineHandle | undefined;
    if (adopt) {
      handle = await this.adopt(path, onAddress);
    }
    if (handle === undefined) {
      const generation = (this.generations.get(path) ?? 0) + 1;
      this.generations.set(path, generation);
      handle = await this.deps.engines.createShared(path, generation, onAddress);
      this.deps.metrics.engineStarts.inc({ stream: "" });
    }
    if (instance.ip !== handle.ip) {
      await this.route(instance, handle.ip);
    }
    instance.handle = handle;
    if (instance.users.size === 0) {
      instance.idleSince = this.now();
    }
    return handle;
  }

  /** Takes over the newest engine of the path left from a previous run; removes the older ones. */
  private async adopt(
    path: string,
    onAddress: (handle: EngineHandle) => Promise<void>,
  ): Promise<EngineHandle | undefined> {
    const inUse = new Set(
      [...this.retiring].map((instance) => instance.handle?.containerId).filter((id) => id !== undefined),
    );
    const found = await this.deps.engines.findShared(path);
    const existing = found.filter((handle) => !inUse.has(handle.containerId));
    const [newest, ...older] = existing;
    for (const handle of existing) {
      this.generations.set(path, Math.max(this.generations.get(path) ?? 0, handle.generation));
    }
    for (const handle of older) {
      await this.deps.engines.remove(handle);
    }
    if (newest === undefined) {
      return undefined;
    }
    try {
      const handle = await this.deps.engines.revive(newest, onAddress);
      this.logger.info({ path, engine: handle.name }, "took over the shared engine of the previous run");
      return handle;
    } catch (error) {
      this.logger.warn({ err: error, engine: newest.name }, "could not take over a shared engine; starting a new one");
      await this.deps.engines.remove(newest).catch(() => undefined);
      return undefined;
    }
  }

  /** Starts a new engine for the path; once it answers, streams move to it. */
  private replace(instance: Instance, reason: SharedRestartReason): boolean {
    const { path } = instance;
    if (this.replacing.has(path)) {
      return true;
    }
    if (this.now() < (this.blockedUntil.get(path) ?? 0)) {
      return false;
    }
    this.replacing.add(path);
    this.logger.warn(
      { path, reason, engine: instance.handle?.name, streams: instance.users.size },
      "replacing the shared engine",
    );
    this.deps.metrics.sharedEngineRestarts.inc({ path, reason });
    const next = this.start(path, false);
    void next.ready
      .then(async () => {
        const current = this.current.get(path);
        if (current !== undefined && current !== instance) {
          // The old engine went away meanwhile and the path already has another one.
          await this.remove(next, "a newer engine took over");
          return;
        }
        this.current.set(path, next);
        if (current !== undefined) {
          await this.retire(current);
        }
      })
      .catch(() => {
        // Logged in `start`. Wait before trying again, so a path that can't start engines doesn't
        // create one on every failure.
        this.blockedUntil.set(path, this.now() + this.deps.settings.failureWindowMs);
      })
      .finally(() => {
        this.replacing.delete(path);
      });
    return true;
  }

  /** The engine was replaced: it goes once its last stream left, or after the timeout. */
  private async retire(instance: Instance): Promise<void> {
    instance.retiring = true;
    this.retiring.add(instance);
    if (instance.users.size === 0) {
      await this.remove(instance, "replaced");
      return;
    }
    instance.retireTimer = setTimeout(() => {
      void this.remove(instance, "replaced, and its last streams did not leave in time");
    }, this.deps.settings.retireTimeoutMs);
    instance.retireTimer.unref();
  }

  private async remove(instance: Instance, why: string): Promise<void> {
    if (this.current.get(instance.path) === instance) {
      this.current.delete(instance.path);
    }
    this.retiring.delete(instance);
    clearTimeout(instance.retireTimer);
    this.unroute(instance);
    const handle = instance.handle;
    if (handle === undefined) {
      return;
    }
    this.logger.info({ path: instance.path, engine: handle.name, reason: why }, "removing shared engine");
    await this.deps.engines.remove(handle).catch((error: unknown) => {
      this.logger.warn({ err: error, engine: handle.name }, "could not remove a shared engine");
    });
  }

  /** Gives the engine's address its path at the gateway. A failed call is retried by the periodic sync. */
  private async route(instance: Instance, ip: string): Promise<void> {
    if (instance.ip !== undefined && instance.ip !== ip) {
      this.unroute(instance);
    }
    instance.ip = ip;
    await this.deps.netgw.assign({ ip, path: instance.path }).catch((error: unknown) => {
      this.logger.warn({ err: error, path: instance.path }, "could not assign the shared engine's path yet");
    });
  }

  private unroute(instance: Instance): void {
    const ip = instance.ip;
    if (ip === undefined) {
      return;
    }
    instance.ip = undefined;
    void this.deps.netgw.unassign(ip).catch(() => undefined);
  }
}
