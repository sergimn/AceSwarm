import type { PathAssignment } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { NetgwClient } from "./clients.ts";
import { EngineGoneError, type EngineHandle, type EngineManager } from "./engines.ts";
import type { ControllerMetrics } from "./metrics.ts";

export interface SharedEngineSettings {
  /** A shared engine restarts once more than this many of its streams failed within the window. */
  maxFailures: number;
  failureWindowMs: number;
  /** A replaced engine is removed after this long, even if a stream did not manage to leave it. */
  retireTimeoutMs: number;
  /**
   * A path's engine that no stream uses any more is removed after this long (at the next sweep),
   * counted from when the last stream that played from it left.
   */
  idleTimeoutMs: number;
}

/** Why a shared engine was replaced. */
export type SharedRestartReason = "watched" | "failures" | "all-failed" | "manual" | "unresponsive";

export interface FailureReport {
  /** Someone watches the stream full screen. */
  watched: boolean;
  /** The stream's recovery ladder reached the step where it would restart its own engine. */
  wantsRestart: boolean;
  /**
   * The stream played from this engine before it failed. One that never did (a broadcast that is
   * down, say) says little about the engine, so it can't replace it on its own.
   */
  hadVideo: boolean;
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
  /** Last failure of each stream on this engine, and whether the stream had played from it. */
  readonly failures: Map<string, { at: number; hadVideo: boolean }>;
  /**
   * Where the idle timeout starts, once no stream uses it: when the last stream that played from it
   * left, or the first stream that didn't (or when it became ready without one).
   */
  idleSince: number | undefined;
  retiring: boolean;
  retireTimer: NodeJS.Timeout | undefined;
  /** A running check that the engine still answers (see `rejoin`). */
  checking: Promise<EngineHandle> | undefined;
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
 * on it reached the point where it would restart its own engine; at most once per failure window.
 * Replacing is make-before-break: a new engine starts on the same path, each stream moves over
 * (handing its picture over once the new engine delivers video), and the old engine goes once its
 * last stream left.
 */
export class SharedEngines {
  private readonly deps: SharedEnginesDeps;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** The engine new sessions go to, per path. */
  private readonly current = new Map<string, Instance>();
  /** Replaced engines whose streams are still moving away. */
  private readonly retiring = new Set<Instance>();
  /** The engine starting to replace the path's current one. */
  private readonly pending = new Map<string, Instance>();
  /** No replacement before this time, per path: a failure window after the last one. */
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
    const current = this.current.get(path);
    if (current?.handle !== undefined && (current.users.size === 0 || current.checking !== undefined)) {
      // No stream uses it, so none noticed if it stopped or hangs: check it first.
      return this.rejoin(current.handle, streamId);
    }
    // While a replacement starts and the old engine is already gone, streams wait for it.
    const instance = current ?? this.pending.get(path) ?? this.start(path, true);
    instance.users.add(streamId);
    try {
      const ready = await instance.ready;
      // It may have restarted on a new address since it became ready (see `check`).
      return instance.handle ?? ready;
    } catch (error) {
      instance.users.delete(streamId);
      throw error;
    }
  }

  /**
   * A stream starts again on the engine it had, which is still its path's engine. Waits until the
   * engine answers, starting it again if it stopped. An engine that is gone or doesn't answer is
   * removed, and the stream gets the path's next engine. Other errors (the Docker API failing for a
   * moment) leave the engine alone: the stream tries again later.
   */
  async rejoin(handle: EngineHandle, streamId: string): Promise<EngineHandle> {
    const instance = this.find(handle);
    if (instance === undefined || this.current.get(instance.path) !== instance) {
      if (instance !== undefined) {
        await this.release(handle, streamId, false);
      }
      return this.acquire(handle.sharedPath ?? "", streamId);
    }
    instance.users.add(streamId);
    try {
      return await this.check(instance, handle);
    } catch (error) {
      instance.users.delete(streamId);
      if (!(error instanceof EngineGoneError)) {
        if (instance.users.size === 0) {
          // The error says nothing about the engine, and the stream comes straight back.
          instance.idleSince = this.now();
        }
        throw error;
      }
      if (this.current.get(instance.path) === instance) {
        this.logger.warn(
          { err: error, path: instance.path, engine: handle.name },
          "the shared engine stopped answering",
        );
        this.deps.metrics.sharedEngineRestarts.inc({ path: instance.path, reason: "unresponsive" });
        await this.remove(instance, "it stopped answering");
      }
      return this.acquire(instance.path, streamId);
    }
  }

  /**
   * The stream left the engine. A replaced engine without streams is removed. A path's engine stays
   * for the idle timeout (see `sweepIdle`): a stream whose move to it failed comes back to it, and a
   * new engine would start cold, which can take minutes to find peers. A stream that never `played`
   * from it doesn't start the timeout again, so an engine that only ever failed goes after it and
   * the next try gets a new one.
   */
  async release(handle: EngineHandle, streamId: string, played: boolean): Promise<void> {
    const instance = this.find(handle);
    if (instance === undefined) {
      return;
    }
    instance.users.delete(streamId);
    instance.failures.delete(streamId);
    if (played || instance.idleSince === undefined) {
      instance.idleSince = this.now();
    }
    if (instance.retiring && instance.users.size === 0) {
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
    instance.failures.set(streamId, { at: now, hadVideo: report.hadVideo });
    for (const [stream, { at }] of instance.failures) {
      if (now - at > this.deps.settings.failureWindowMs || !instance.users.has(stream)) {
        instance.failures.delete(stream);
      }
    }
    const reason = this.restartReason(instance, report);
    if (reason === undefined || !this.replace(instance, reason)) {
      this.logger.info(
        { path: instance.path, stream: streamId, failing: instance.failures.size, streams: instance.users.size },
        "a stream on the shared engine failed; keeping the engine",
      );
      return this.pending.has(instance.path);
    }
    return true;
  }

  /** Replaces the engine because someone asked for it (a manual restart). */
  restart(handle: EngineHandle): boolean {
    const instance = this.find(handle);
    return instance !== undefined && !instance.retiring && this.replace(instance, "manual");
  }

  /** The gateway paths of every shared engine, by engine address (re-sent periodically). */
  assignments(): PathAssignment[] {
    const assignments: PathAssignment[] = [];
    for (const instance of this.instances()) {
      if (instance.ip !== undefined) {
        assignments.push({ ip: instance.ip, path: instance.path });
      }
    }
    return assignments;
  }

  view(): SharedEngineView[] {
    return this.instances()
      .filter((instance) => instance.handle !== undefined)
      .map((instance) => ({
        path: instance.path,
        engine: instance.handle?.name ?? "",
        streams: instance.users.size,
        retiring: instance.retiring,
      }));
  }

  /**
   * Removes the paths' engines that no stream used for the idle timeout. While sharing is off no
   * stream comes back to them, so they go once no stream uses them.
   */
  async sweepIdle(sharing: boolean): Promise<void> {
    const timeoutMs = sharing ? this.deps.settings.idleTimeoutMs : 0;
    for (const instance of this.current.values()) {
      // Checked again for each: a stream may take an engine while the one before it is removed.
      if (this.current.get(instance.path) === instance && this.isIdle(instance, timeoutMs)) {
        await this.remove(instance, "no stream uses it");
      }
    }
  }

  /**
   * Removes shared engines left from a previous run that no stream took over. Call it once every
   * stream had the chance to take its engine (the orchestrator does, after every stream's first
   * start attempt).
   */
  async sweepOrphans(): Promise<void> {
    const now = this.now();
    if (now - this.lastOrphanSweep < 60_000) {
      return;
    }
    this.lastOrphanSweep = now;
    const known = new Set<string>();
    const starting = new Set<string>();
    for (const instance of this.instances()) {
      if (instance.handle === undefined) {
        starting.add(instance.path);
      } else {
        known.add(instance.handle.containerId);
      }
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

  /** Every engine: the paths' current ones, the ones being replaced and their replacements. */
  private instances(): Instance[] {
    return [...this.current.values(), ...this.retiring, ...this.pending.values()];
  }

  /**
   * A path's engine nobody used for the idle timeout. While its path still has an engine being
   * replaced, streams are still on their way to it.
   */
  private isIdle(instance: Instance, timeoutMs: number): boolean {
    const replacing = this.pending.has(instance.path) || [...this.retiring].some(({ path }) => path === instance.path);
    return (
      instance.handle !== undefined &&
      instance.users.size === 0 &&
      !replacing &&
      instance.idleSince !== undefined &&
      this.now() - instance.idleSince >= timeoutMs
    );
  }

  /** Why the engine should be replaced after this report, if it should. */
  private restartReason(instance: Instance, report: FailureReport): SharedRestartReason | undefined {
    if (report.watched && report.hadVideo) {
      return "watched";
    }
    const played = instance.failures
      .values()
      .filter(({ hadVideo }) => hadVideo)
      .toArray();
    if (played.length > this.deps.settings.maxFailures) {
      return "failures";
    }
    if (report.wantsRestart && [...instance.users].every((stream) => instance.failures.has(stream))) {
      return "all-failed";
    }
    return undefined;
  }

  /** Waits until the engine answers, starting it again if it stopped (one check at a time). */
  private async check(instance: Instance, handle: EngineHandle): Promise<EngineHandle> {
    instance.checking ??= this.deps.engines
      .revive(handle, async (starting) => {
        await this.route(instance, starting.ip);
      })
      .then((revived) => {
        instance.handle = revived;
        return revived;
      })
      .finally(() => {
        instance.checking = undefined;
      });
    return await instance.checking;
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
      checking: undefined,
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
      this.instances()
        .map((instance) => instance.handle?.containerId)
        .filter((id) => id !== undefined),
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

  /**
   * Starts a new engine for the path; once it answers, streams move to it. Apart from a manual
   * restart, the path's engine is replaced at most once per failure window: when the new engine
   * doesn't help either, the streams' own recovery goes on.
   */
  private replace(instance: Instance, reason: SharedRestartReason): boolean {
    const { path } = instance;
    if (this.pending.has(path)) {
      return true;
    }
    if (reason !== "manual" && this.now() < (this.blockedUntil.get(path) ?? 0)) {
      return false;
    }
    this.logger.warn(
      { path, reason, engine: instance.handle?.name, streams: instance.users.size },
      "replacing the shared engine",
    );
    this.deps.metrics.sharedEngineRestarts.inc({ path, reason });
    const next = this.start(path, false);
    this.pending.set(path, next);
    void next.ready
      .then(async () => {
        const current = this.current.get(path);
        this.current.set(path, next);
        this.pending.delete(path);
        if (current !== undefined) {
          await this.retire(current);
        }
      })
      .catch(() => {
        // Logged in `start`.
        this.pending.delete(path);
      })
      .finally(() => {
        // Also after a replacement that didn't start, so a path that can't start engines doesn't
        // create one on every failure.
        this.blockedUntil.set(path, this.now() + this.deps.settings.failureWindowMs);
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
    if (this.retiring.delete(instance)) {
      // The streams that were moving away are gone: from now on the path's engine is idle while
      // nobody uses it.
      const current = this.current.get(instance.path);
      if (current?.users.size === 0) {
        current.idleSince = this.now();
      }
    }
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
