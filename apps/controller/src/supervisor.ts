import type {
  PathStatus,
  PathStrategyName,
  PeerStats,
  PipelineStatus,
  StreamState,
  StreamView,
  PathAssignment,
} from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import type { EngineSession, EngineStats } from "./acestream.ts";
import type { EngineHandle } from "./engines.ts";
import { evaluateHealth } from "./health.ts";
import { sleep, startSessionOfAnyKind } from "./playback.ts";
import { nextRecovery, type RecoveryAction, type RecoveryPolicy, type RecoveryState } from "./recovery.ts";
import { StreamEngines, type StreamEnginesDeps } from "./stream-engines.ts";
import { StreamPaths } from "./stream-paths.ts";
import { streamView } from "./stream-view.ts";
import type { StreamConfig } from "./stream-store.ts";

export interface SupervisorSettings {
  tickMs: number;
  stallAfterMs: number;
  startupGraceMs: number;
  recoveryBaseDelayMs: number;
  recoveryMaxDelayMs: number;
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
  /** Number of players showing this stream full screen. */
  viewers?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Keeps one stream alive: owns its engine (or its place on its path's shared engine), playback
 * session, transcoder pipeline and network path, polls their health and walks the recovery ladder
 * when video stops.
 */
export class StreamSupervisor {
  private stream: StreamConfig;
  private readonly deps: SupervisorDeps;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly policy: RecoveryPolicy;

  private engine: EngineHandle | undefined;
  private session: EngineSession | undefined;
  private attemptStartedAt = 0;
  private pipeline: PipelineStatus | undefined;
  private stats: EngineStats | undefined;
  private peers: PeerStats | undefined;
  private state: StreamState = "starting";
  private stateSince: number;
  private message: string | null = null;
  private recovery: RecoveryState = { failures: 0, lastActionAt: undefined };
  /** The paths this stream may use, and its history on them. */
  private readonly paths: StreamPaths;
  private lastSwitchAt = 0;
  private recoveries = 0;
  private forceRestart = false;
  /** Its own engines (with their gateway paths) or its place on a shared engine. */
  private readonly engines: StreamEngines;
  private bootstrapped = false;

  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private current: Promise<void> = Promise.resolve();

  constructor(stream: StreamConfig, deps: SupervisorDeps) {
    this.stream = stream;
    this.deps = deps;
    this.engines = new StreamEngines(stream.id, deps);
    this.logger = deps.logger.child({ stream: stream.id, aceId: stream.aceId });
    this.paths = new StreamPaths({
      paths: deps.paths,
      pathAllowed: deps.pathAllowed,
      pathLoad: deps.pathLoad,
      strategy: deps.settings.pathStrategy,
      logger: this.logger,
    });
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? sleep;
    this.policy = { baseDelayMs: deps.settings.recoveryBaseDelayMs, maxDelayMs: deps.settings.recoveryMaxDelayMs };
    this.stateSince = this.now();
  }

  get id(): string {
    return this.stream.id;
  }

  get path(): string | null {
    return this.stream.path;
  }

  /** What this stream's own engines should use at the gateway (re-sent periodically). */
  assignments(): PathAssignment[] {
    return this.engines.gateway.list();
  }

  /** True once the first start attempt finished, so `assignments()` is complete. */
  get settled(): boolean {
    return this.bootstrapped || !this.running;
  }

  /** True once it tried to start an engine (or take over its last one), or doesn't need one. */
  get triedEngine(): boolean {
    return this.engines.tried || !this.running;
  }

  get isPlaying(): boolean {
    return this.state === "playing";
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  /** Stops supervising. With `teardown`, also removes the engine and pipeline. */
  async stop(teardown: boolean): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    await this.current;
    if (teardown) {
      await this.teardown();
    }
  }

  updateConfig(stream: StreamConfig): void {
    this.stream = stream;
  }

  requestRestart(): void {
    this.forceRestart = true;
  }

  view(): StreamView {
    const { state, stateSince, message, pipeline, stats, peers, recoveries, engine } = this;
    const live = { state, stateSince, message, pipeline, stats, peers, recoveries, engine };
    return streamView(this.stream, this.deps.viewers?.() ?? 0, live);
  }

  /** Streams on the same path share one engine. */
  private get sharing(): boolean {
    return this.deps.shared !== undefined && this.deps.sharedEngines?.() === true;
  }

  /** Runs a single supervision step. Public for tests; the timer calls it in production. */
  async tick(): Promise<void> {
    await this.engines.expireSpare();
    if (this.engine === undefined || this.session === undefined) {
      await this.bootstrap();
      return;
    }
    if (this.forceRestart) {
      this.forceRestart = false;
      await this.restartByHand(this.engine);
      return;
    }
    if (this.engine.sharedPath === null && !this.engines.gateway.has(this.engine.ip)) {
      // The gateway blocks an engine until it has a path. This one started while the gateway's
      // paths were unknown (for example while it restarted), or no path it may use was up, or its
      // last assignment failed.
      await this.assignStartPath(this.engine);
      if (this.engines.gateway.has(this.engine.ip)) {
        // It was cut off until now: give it the usual time to find its peers.
        this.attemptStartedAt = this.now();
      } else if (this.paths.noneUsable()) {
        // Restarting the session or the engine can't help while there is nowhere to send it.
        this.setState("stalled", this.paths.waitingMessage());
        return;
      }
    }
    await this.poll();
    // Before any move: the engine a move kept may be what the transcoder already plays from.
    if (await this.engines.finishLateMove(this.engine, this.session, this.pipeline)) {
      return;
    }
    if (this.stream.path !== null && !this.paths.allowed(this.stream.path)) {
      await this.leaveDisallowedPath(this.engine);
      return;
    }
    if (await this.moveToWantedEngine(this.engine)) {
      return;
    }
    const health = evaluateHealth({
      now: this.now(),
      attemptStartedAt: this.attemptStartedAt,
      pipeline: this.pipeline,
      engineStatus: this.stats?.status,
      stallAfterMs: this.deps.settings.stallAfterMs,
      startupGraceMs: this.deps.settings.startupGraceMs,
    });
    if (this.stream.path !== null && health.state !== "starting" && health.state !== "buffering") {
      this.paths.remember(this.stream.path, health.healthy);
    }
    if (health.healthy) {
      await this.engines.played(this.engine, this.sharing);
      if (this.recovery.failures > 0) {
        this.logger.info({ failures: this.recovery.failures }, "stream recovered");
      }
      this.recovery = { failures: 0, lastActionAt: undefined };
      this.setState("playing", null);
      return;
    }
    if (health.state === "starting" || health.state === "buffering") {
      this.setState(health.state, health.reason);
      return;
    }
    await this.recover(health.reason);
  }

  /**
   * The user asked for a restart. A stream's own engine restarts. On a shared engine, the stream's
   * session restarts now and the engine is replaced in the background: this stream and every other
   * one on it then move over without losing their picture.
   */
  private async restartByHand(engine: EngineHandle): Promise<void> {
    if (engine.sharedPath !== null) {
      this.deps.shared?.restart(engine);
    }
    await this.runAction("restart-engine", "manual restart");
  }

  private schedule(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      this.current = this.tick()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, "supervisor tick failed");
        })
        .finally(() => {
          this.schedule(this.deps.settings.tickMs);
        });
    }, delayMs);
  }

  private setState(state: StreamState, message: string | null): void {
    if (state !== this.state) {
      this.logger.info({ from: this.state, to: state, reason: message }, "stream state changed");
      this.state = state;
      this.stateSince = this.now();
    }
    this.message = message;
  }

  private async bootstrap(): Promise<void> {
    if (this.recovery.lastActionAt !== undefined) {
      const { notBefore } = nextRecovery(this.recovery, this.policy, false);
      if (this.now() < notBefore) {
        return;
      }
    }
    try {
      if (this.paths.noneUsable()) {
        // No engine until there is a path for it: the gateway would only block it.
        this.setState("stalled", this.paths.waitingMessage());
        return;
      }
      if (this.sharing) {
        await this.bootstrapShared();
        return;
      }
      this.setState("starting", "starting engine");
      this.engine = await this.engines.startOwn(this.engine, async (starting) => {
        await this.assignStartPath(starting);
      });
      if (!this.engines.gateway.has(this.engine.ip)) {
        // The gateway's paths were not known yet while it started, or the assignment failed.
        await this.assignStartPath(this.engine);
      }
      this.setState("starting", "opening stream");
      await this.startPlayback(this.engine);
    } catch (error) {
      this.recovery = { failures: this.recovery.failures + 1, lastActionAt: this.now() };
      this.setState("error", describeError(error));
      this.logger.warn({ err: error }, "could not start stream");
    } finally {
      this.bootstrapped = true;
    }
  }

  /** Starts the stream on its path's shared engine. */
  private async bootstrapShared(): Promise<void> {
    if (!this.paths.known) {
      // The shared engine to use depends on the path.
      this.setState("starting", "waiting for the network gateway");
      return;
    }
    const path = this.paths.forStart(this.stream.path, this.recovery.failures);
    if (path === undefined) {
      this.setState("stalled", this.paths.waitingMessage());
      return;
    }
    this.setState("starting", "starting engine");
    this.engine = await this.engines.startShared(path, this.engine);
    await this.persistPath(path);
    this.setState("starting", "opening stream");
    await this.startPlayback(this.engine);
  }

  /** Moves the stream to the kind of engine the setting asks for (see `StreamEngines.moveToWanted`). */
  private async moveToWantedEngine(engine: EngineHandle): Promise<boolean> {
    const path = this.stream.path;
    if (path === null || !this.paths.known || this.paths.isDown(path)) {
      // Recovery has to find the stream a path first.
      return false;
    }
    return this.engines.moveToWanted(engine, {
      sharing: this.sharing,
      policy: this.policy,
      now: this.now(),
      logger: this.logger,
      move: async () => {
        await this.moveTo(engine, path, { switchingPath: false, handover: this.state === "playing" });
      },
    });
  }

  private async poll(): Promise<void> {
    if (this.engine === undefined || this.session === undefined) {
      return;
    }
    const polled = await this.engines.poll(this.engine, this.session, this.pipeline);
    this.pipeline = polled.pipeline;
    this.stats = polled.stats;
    this.peers = polled.peers;
  }

  /**
   * The stream uses a path the policy no longer allows: WireGuard only was turned on while it was
   * on the direct path. The gateway has already cut its engine off, so it moves now rather than
   * once the stall is noticed. This is not a recovery: the stream was healthy. Failed moves wait
   * like recovery steps do, so a VPN that can't carry the stream doesn't churn engines, and only a
   * few streams move at once, because each move starts a second engine.
   */
  private async leaveDisallowedPath(engine: EngineHandle): Promise<void> {
    if (!this.paths.known || this.paths.noneUsable()) {
      // While the gateway is unreachable its paths are unknown: nothing to move to yet.
      this.setState("stalled", this.paths.known ? this.paths.waitingMessage() : "waiting for the network gateway");
      return;
    }
    const from = this.stream.path ?? "?";
    const wait = nextRecovery(this.recovery, this.policy, true).notBefore - this.now();
    const slots = this.deps.policyMoves;
    if (wait > 0 || slots?.tryTake() === false) {
      const reason = wait > 0 ? `moving again in ${String(Math.ceil(wait / 1000))}s` : "other streams move first";
      this.setState("stalled", `path ${from} is off; ${reason}`);
      return;
    }
    this.logger.info({ path: from }, "path is off (WireGuard only); moving the stream");
    try {
      await this.switchPath(engine);
      // Video arrived on the new path.
      this.recovery = { failures: 0, lastActionAt: undefined };
    } catch (error) {
      // The wait counts from the failure: a move can take until the handover timeout to fail.
      this.recovery = { failures: this.recovery.failures + 1, lastActionAt: this.now() };
      this.setState("stalled", `moving off ${from} failed: ${describeError(error)}`);
      this.logger.warn({ err: error, path: from }, "could not move the stream off a path that is off");
    } finally {
      slots?.release();
    }
  }

  private canSwitchPath(): boolean {
    if (!this.paths.hasAlternative(this.stream.path)) {
      return false;
    }
    const dwellOver = this.now() - this.lastSwitchAt >= this.deps.settings.pathMinDwellMs;
    return dwellOver || this.paths.isDown(this.stream.path);
  }

  private async recover(why: string): Promise<void> {
    let reason = why;
    const decision = nextRecovery(this.recovery, this.policy, this.canSwitchPath());
    const wait = decision.notBefore - this.now();
    if (wait > 0) {
      this.setState("stalled", `${reason}; retrying in ${String(Math.ceil(wait / 1000))}s`);
      return;
    }
    // On a shared engine, other streams play from the same engine: the shared engines decide
    // whether it restarts.
    const report = { watched: (this.deps.viewers?.() ?? 0) > 0, wantsRestart: decision.action === "restart-engine" };
    // A path that is down says nothing about the engine: the stream leaves the path instead.
    if (
      this.engine !== undefined &&
      !this.paths.isDown(this.stream.path) &&
      this.engines.reportFailure(this.engine, report)
    ) {
      reason += "; replacing the shared engine";
    }
    // A dead path cannot be fixed by restarting things locally: leave it, without waiting for the
    // ladder to reach a path switch. The delay above still applies, so a move that keeps failing
    // doesn't create and remove an engine on every tick.
    if (this.paths.isDown(this.stream.path) && this.canSwitchPath()) {
      await this.runAction("switch-path", `${reason}; path ${this.stream.path ?? "?"} is down`);
      return;
    }
    await this.runAction(decision.action, reason);
  }

  private async runAction(action: RecoveryAction, reason: string): Promise<void> {
    const engine = this.engine;
    if (engine === undefined) {
      return;
    }
    this.recoveries += 1;
    this.recovery = { failures: this.recovery.failures + 1, lastActionAt: this.now() };
    this.deps.metrics.recoveries.inc({ stream: this.stream.id, action });
    this.logger.warn({ action, reason, failures: this.recovery.failures }, "recovering stream");
    this.setState("recovering", `${reason}; ${action.replace("-", " ")}`);
    try {
      if (action === "restart-pipeline") {
        await this.stopSessionQuietly();
        await this.startPlayback(engine);
      } else if (action === "restart-engine") {
        await this.runRestartInPlace(engine);
      } else {
        await this.switchPath(engine);
      }
    } catch (error) {
      this.setState("stalled", `${action.replace("-", " ")} failed: ${describeError(error)}`);
      this.logger.warn({ err: error, action }, "recovery action failed");
    }
  }

  /**
   * Moves the stream to another network path, make-before-break: a second engine starts on the
   * new path (or the path's shared engine is used) and the transcoder only cuts over once it
   * delivers video, then the old engine goes.
   */
  private async switchPath(engine: EngineHandle): Promise<void> {
    const from = this.stream.path ?? "none";
    const target = this.paths.switchTarget(from);
    if (target === undefined && !this.paths.allowed(from)) {
      // Restarting in place would put the engine back on a path it may not use.
      throw new Error("no path it may use is up");
    }
    if (target === undefined) {
      this.logger.info({ path: from }, "no better path; restarting engine instead");
      await this.runRestartInPlace(engine);
      return;
    }
    this.setState("switching", `moving from ${from} to ${target}`);
    await this.moveTo(engine, target, { switchingPath: true, handover: true });
  }

  /**
   * Moves the stream from `engine` to another one on `target`: a new engine of its own, or the
   * path's shared engine while sharing is on. With `handover`, the transcoder keeps the current
   * picture until the new engine delivers video, and the move fails (leaving the stream where it
   * was) if it doesn't.
   */
  private async moveTo(
    engine: EngineHandle,
    target: string,
    options: { switchingPath: boolean; handover: boolean },
  ): Promise<void> {
    const from = this.stream.path ?? "none";
    const { handoverTimeoutMs: timeoutMs, tickMs: pollMs } = this.deps.settings;
    await this.engines.move({
      from: engine,
      session: this.session,
      target,
      shared: this.sharing,
      handover: options.handover ? { timeoutMs, pollMs, now: this.now, sleep: this.sleep } : undefined,
      openSession: async (baseUrl) => this.openSession(baseUrl),
      commit: async (moved) => {
        this.engine = moved.engine;
        this.session = moved.session;
        this.pipeline = moved.pipeline;
        this.attemptStartedAt = this.now();
        await this.persistPath(target);
        if (options.switchingPath) {
          this.lastSwitchAt = this.now();
          this.deps.metrics.pathSwitches.inc({ stream: this.stream.id, from, to: target });
        }
        this.logger.info({ from, to: target, engine: moved.engine.name }, "stream moved to another engine");
      },
    });
  }

  private async runRestartInPlace(engine: EngineHandle): Promise<void> {
    await this.stopSessionQuietly();
    if (engine.sharedPath !== null) {
      // Other streams play from it: only this stream's session restarts. The shared engines
      // replace the engine itself when their rules say so (see `recover`).
      await this.startPlayback(engine);
      return;
    }
    // Its own path, unless the policy turned that off (a manual restart right after WireGuard only
    // was turned on, say): then the path a start attempt would get.
    const path =
      this.stream.path === null || this.paths.allowed(this.stream.path)
        ? this.stream.path
        : (this.paths.forStart(this.stream.path, 0) ?? null);
    const restarted = await this.engines.restartOwn(engine, async (starting) => {
      await this.applyPath(starting, path);
    });
    this.engine = restarted;
    if (!this.engines.gateway.has(restarted.ip)) {
      await this.applyPath(restarted, path);
    }
    await this.startPlayback(restarted);
  }

  private async startPlayback(engine: EngineHandle): Promise<void> {
    const session = await this.openSession(engine.baseUrl);
    this.session = session;
    this.attemptStartedAt = this.now();
    this.stats = undefined;
    this.pipeline = await this.deps.transcoder.start(this.stream.id, { source: session.playbackUrl });
  }

  /** Starts an engine session and remembers which kind of identifier the engine accepted. */
  private async openSession(baseUrl: string): Promise<EngineSession> {
    const { session, kind } = await startSessionOfAnyKind(
      this.deps.ace,
      baseUrl,
      this.stream.aceId,
      this.stream.aceIdKind,
    );
    if (this.stream.aceIdKind !== kind) {
      this.logger.info({ kind }, "engine accepted the stream identifier");
      this.stream = { ...this.stream, aceIdKind: kind };
      await this.deps.store.update(this.stream.id, { aceIdKind: kind });
    }
    return session;
  }

  /** Gives the engine the path for a start attempt, once the gateway's paths are known. */
  private async assignStartPath(engine: EngineHandle): Promise<void> {
    if (!this.paths.known) {
      return;
    }
    await this.applyPath(engine, this.paths.forStart(this.stream.path, this.recovery.failures) ?? null);
  }

  private async applyPath(engine: EngineHandle, path: string | null): Promise<void> {
    if (path === null) {
      return;
    }
    try {
      await this.engines.gateway.assign(engine.ip, path);
      await this.persistPath(path);
    } catch (error) {
      this.logger.warn({ err: error, path }, "could not assign network path");
    }
  }

  private async persistPath(path: string): Promise<void> {
    if (this.stream.path === path) {
      return;
    }
    this.stream = { ...this.stream, path };
    await this.deps.store.update(this.stream.id, { path });
  }

  private async stopSessionQuietly(): Promise<void> {
    if (this.session === undefined) {
      return;
    }

    await this.deps.ace.stopSession(this.session.commandUrl).catch(() => undefined);
    this.session = undefined;
  }

  private async teardown(): Promise<void> {
    await this.deps.transcoder.stop(this.stream.id).catch(() => undefined);
    await this.stopSessionQuietly();
    await this.engines.releaseAll(this.engine).catch((error: unknown) => {
      this.logger.warn({ err: error }, "could not remove engines");
    });
    this.engine = undefined;
    this.setState("stopped", null);
  }
}
