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
import { duration, evaluateHealth } from "./health.ts";
import { sleep, waitAtMost } from "./playback.ts";
import { leaveDisallowedPath } from "./policy-move.ts";
import { nextRecovery, type RecoveryAction, type RecoveryPolicy, type RecoveryState } from "./recovery.ts";
import { SourceWait } from "./source-wait.ts";
import { StreamEngines, type MovedStream, type StreamEnginesDeps } from "./stream-engines.ts";
import { StreamFailover, type PlayingStream } from "./stream-failover.ts";
import { StreamPaths } from "./stream-paths.ts";
import { StreamRecord } from "./stream-record.ts";
import { streamView } from "./stream-view.ts";
import type { StreamConfig } from "./stream-store.ts";

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
  /** Its config, with what it learned about the stream saved in the store. */
  private readonly record: StreamRecord;
  private readonly deps: SupervisorDeps;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly policy: RecoveryPolicy;
  /** Waiting for its broadcast while that sends nothing new. */
  private readonly sourceWait: SourceWait;

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
  /** Its own engines (with their gateway paths) or its place on a shared engine, and its standbys. */
  private readonly engines: StreamEngines;
  private bootstrapped = false;
  /** Its hot standbys on the other paths, and failing over to them. */
  private readonly failover: StreamFailover;

  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private current: Promise<void> = Promise.resolve();

  constructor(stream: StreamConfig, deps: SupervisorDeps) {
    this.deps = deps;
    this.engines = new StreamEngines(stream.id, deps);
    this.logger = deps.logger.child({ stream: stream.id, aceId: stream.aceId });
    this.record = new StreamRecord(stream, { ...deps, logger: this.logger, gateway: this.engines.gateway });
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
    this.sourceWait = new SourceWait(this.logger, this.policy, deps.settings.staleSourceRetryMs);
    this.stateSince = this.now();
    this.failover = new StreamFailover(stream.id, this.engines, this.paths, {
      ...deps,
      logger: this.logger,
      now: this.now,
      sleep: this.sleep,
      enabled: () => deps.hotStandby?.() === true,
      sharing: () => this.sharing,
      playing: () => this.playing(),
      sourceStale: () => this.sourceWait.waiting,
      setState: this.setState,
      countRecovery: () => {
        this.recoveries += 1;
      },
      commit: async (moved, path) => this.commitMove(moved, path, true),
      openSession: async (baseUrl) => this.record.openSession(baseUrl),
    });
  }

  private get stream(): StreamConfig {
    return this.record.config;
  }

  get path(): string | null {
    return this.stream.path;
  }

  /** What this stream's own engines and standbys should use at the gateway (re-sent periodically). */
  assignments(): PathAssignment[] {
    return this.engines.assignments();
  }

  /** True once the first start attempt finished, so `assignments()` is complete. */
  get settled(): boolean {
    return this.bootstrapped || !this.running;
  }

  /** True once it tried to start an engine (or take over its last one), or doesn't need one. */
  get triedEngine(): boolean {
    return this.engines.tried || !this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  /**
   * Stops supervising. With `teardown`, also removes the engine and pipeline, once the step in
   * progress is done. Without, it waits at most `waitMs` for that step: opening a session or a
   * handover can take minutes, and the controller only stops this way to shut down. What the step
   * leaves, the next run takes over.
   */
  async stop(teardown: boolean, waitMs = Infinity): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await waitAtMost(this.current, teardown ? Infinity : waitMs);
    if (teardown) {
      await this.teardown();
    }
  }

  updateConfig(stream: StreamConfig): void {
    this.record.config = stream;
  }

  requestRestart(): void {
    this.forceRestart = true;
  }

  view(): StreamView {
    const { state, stateSince, message, pipeline, stats, peers, recoveries, engine } = this;
    const standbys = this.engines.standbys.view();
    const live = { state, stateSince, message, pipeline, stats, peers, recoveries, engine, standbys };
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
    // Before any move: the engine a move kept, or a standby, may be what the transcoder already
    // plays from.
    if (await this.failover.finishLateMoves()) {
      return;
    }
    await this.failover.maintain();
    if (this.stream.path !== null && !this.paths.allowed(this.stream.path)) {
      await this.leaveDisallowedPath(this.engine);
      return;
    }
    if (await this.moveToWantedEngine(this.engine)) {
      return;
    }
    await this.check(this.engine);
  }

  /** Acts on the stream's health: it plays, it still starts, or it recovers. */
  private async check(engine: EngineHandle): Promise<void> {
    const health = evaluateHealth({
      now: this.now(),
      attemptStartedAt: this.attemptStartedAt,
      pipeline: this.pipeline,
      engineStatus: this.stats?.status,
      stallAfterMs: this.deps.settings.stallAfterMs,
      startupGraceMs: this.deps.settings.startupGraceMs,
    });
    this.paths.rememberHealth(this.stream.path, health);
    if (health.healthy) {
      await this.onVideo(engine);
    } else if (health.state === "starting" || health.state === "buffering") {
      this.setState(this.sourceWait.state(health.state), this.sourceWait.starting(health.reason));
    } else {
      await this.recover(health.reason, health.state === "stale-source");
    }
  }

  /** Video arrives: the stream plays, unless it has been quiet long enough to fail over to a hot standby. */
  private async onVideo(engine: EngineHandle): Promise<void> {
    if (await this.failover.failOverEarly()) {
      return;
    }
    await this.engines.played(engine, this.sharing);
    if (this.recovery.failures > 0) {
      this.logger.info({ failures: this.recovery.failures, sourceStale: this.sourceWait.waiting }, "stream recovered");
    }
    this.recovery = { failures: 0, lastActionAt: undefined };
    this.sourceWait.end();
    this.setState("playing", null);
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
    // Someone stepped in: it acts now, and the ladder's waits start over from this step.
    this.recovery = { failures: 0, lastActionAt: undefined };
    this.sourceWait.due();
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

  private readonly setState = (state: StreamState, message: string | null): void => {
    if (state !== this.state) {
      this.logger.info({ from: this.state, to: state, reason: message }, "stream state changed");
      this.state = state;
      this.stateSince = this.now();
    }
    this.message = message;
  };

  private playing(): PlayingStream {
    const { engine, session, pipeline } = this;
    return { engine, session, pipeline, path: this.stream.path };
  }

  private async bootstrap(): Promise<void> {
    if (this.recovery.lastActionAt !== undefined) {
      const { notBefore } = nextRecovery(this.recovery, this.sourceWait.waits(this.policy), false);
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
      this.setState(this.sourceWait.state("starting"), "starting engine");
      this.engine = await this.engines.startOwn(this.engine, async (starting) => {
        await this.assignStartPath(starting);
      });
      if (!this.engines.gateway.has(this.engine.ip)) {
        // The gateway's paths were not known yet while it started, or the assignment failed.
        await this.assignStartPath(this.engine);
      }
      this.setState(this.sourceWait.state("starting"), "opening stream");
      await this.startPlayback(this.engine);
    } catch (error) {
      this.recovery = { failures: this.recovery.failures + 1, lastActionAt: this.now() };
      this.setState(this.sourceWait.state("error"), describeError(error));
      this.logger.warn({ err: error }, "could not start stream");
    } finally {
      this.bootstrapped = true;
    }
  }

  /** Starts the stream on its path's shared engine. */
  private async bootstrapShared(): Promise<void> {
    if (!this.paths.known) {
      // The shared engine to use depends on the path.
      this.setState(this.sourceWait.state("starting"), "waiting for the network gateway");
      return;
    }
    const path = this.paths.forStart(this.stream.path, this.recovery.failures);
    if (path === undefined) {
      this.setState(this.sourceWait.state("stalled"), this.paths.waitingMessage());
      return;
    }
    this.setState(this.sourceWait.state("starting"), "starting engine");
    this.engine = await this.engines.startShared(path, this.engine);
    await this.record.persistPath(path);
    this.setState(this.sourceWait.state("starting"), "opening stream");
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

  /** It is on a path the policy turned off (see `leaveDisallowedPath`). */
  private async leaveDisallowedPath(engine: EngineHandle): Promise<void> {
    this.recovery = await leaveDisallowedPath({
      paths: this.paths,
      from: this.stream.path,
      recovery: this.recovery,
      policy: this.policy,
      slots: this.deps.policyMoves,
      now: this.now,
      logger: this.logger,
      setState: this.setState,
      switchPath: async () => this.switchPath(engine),
    });
  }

  private canSwitchPath(): boolean {
    return this.paths.canSwitch(this.stream.path, this.now() - this.lastSwitchAt, this.deps.settings.pathMinDwellMs);
  }

  /**
   * Walks the recovery ladder. With a `staleSource` (its broadcast sends nothing new, see
   * `evaluateHealth`), the transcoder already stopped reading it and publishes none of it, and the
   * steps wait longer: each new session or engine is a try to find the broadcast moving again,
   * which only it coming back can make work. A hot standby still takes over, since a standby only
   * counts as hot while its own live edge moves: the broadcast is fine there.
   */
  private async recover(why: string, staleSource = false): Promise<void> {
    let reason = why;
    if (staleSource) {
      this.sourceWait.begin(reason, this.pipeline?.liveEdge);
    }
    const waiting = this.sourceWait.waiting;
    // A hot standby takes over at once, before the ladder: it already pulls the stream.
    if (this.failover.hasHot()) {
      if (!waiting) {
        this.reportToSharedEngine({ wantsRestart: false });
      }
      await this.failover.failOver(`${reason}; failing over to a standby`);
      return;
    }
    const decision = nextRecovery(this.recovery, this.sourceWait.waits(this.policy), this.canSwitchPath(), waiting);
    const wait = this.sourceWait.until(decision.notBefore, this.now(), this.pipeline?.liveEdge);
    if (wait > 0) {
      this.setState(this.sourceWait.state("stalled"), `${reason}; ${this.sourceWait.next} in ${duration(wait)}`);
      return;
    }
    // A broadcast that stopped is not the shared engine's fault: the other streams on it play on.
    if (!waiting && this.reportToSharedEngine({ wantsRestart: decision.action === "restart-engine" })) {
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

  /**
   * On a shared engine, other streams play from the same engine: the shared engines decide whether
   * it restarts. A path that is down says nothing about the engine: the stream leaves the path
   * instead. Returns true when the shared engine is being replaced.
   */
  private reportToSharedEngine(report: { wantsRestart: boolean }): boolean {
    return (
      this.engine !== undefined &&
      !this.paths.isDown(this.stream.path) &&
      this.engines.reportFailure(this.engine, { watched: (this.deps.viewers?.() ?? 0) > 0, ...report })
    );
  }

  /** The stream plays from the engine it moved to, on `target`. */
  private async commitMove(moved: MovedStream, target: string, switchingPath: boolean): Promise<void> {
    const from = this.stream.path ?? "none";
    this.engine = moved.engine;
    this.session = moved.session;
    this.pipeline = moved.pipeline;
    await this.record.playback.save(moved.session);
    this.attemptStartedAt = this.now();
    await this.record.persistPath(target);
    if (switchingPath) {
      this.lastSwitchAt = this.now();
      this.deps.metrics.pathSwitches.inc({ stream: this.stream.id, from, to: target });
    }
    this.logger.info({ from, to: target, engine: moved.engine.name }, "stream moved to another engine");
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
    this.setState(this.sourceWait.state("recovering"), `${reason}; ${action.replace("-", " ")}`);
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
      this.setState(this.sourceWait.state("stalled"), `${action.replace("-", " ")} failed: ${describeError(error)}`);
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
    // A standby already pulls the stream there: a hot one anywhere, or else the one on the target.
    const standby = this.failover.takeForMove(target);
    if (standby !== undefined) {
      await this.failover.moveTo(engine, standby, "moving to the standby");
      return;
    }
    if (target === undefined && !this.paths.allowed(from)) {
      // Restarting in place would put the engine back on a path it may not use.
      throw new Error("no path it may use is up");
    }
    if (target === undefined) {
      this.logger.info({ path: from }, "no better path; restarting engine instead");
      await this.runRestartInPlace(engine);
      return;
    }
    this.setState(this.sourceWait.state("switching"), `moving from ${from} to ${target}`);
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
    const { handoverTimeoutMs: timeoutMs, tickMs: pollMs } = this.deps.settings;
    await this.engines.move({
      from: engine,
      session: this.session,
      target,
      shared: this.sharing,
      handover: options.handover ? { timeoutMs, pollMs, now: this.now, sleep: this.sleep } : undefined,
      openSession: async (baseUrl) => this.record.openSession(baseUrl),
      commit: async (moved) => {
        await this.commitMove(moved, target, options.switchingPath);
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
      await this.record.applyPath(starting, path);
    });
    this.engine = restarted;
    if (!this.engines.gateway.has(restarted.ip)) {
      await this.record.applyPath(restarted, path);
    }
    await this.startPlayback(restarted);
  }

  /**
   * Opens a session on the engine and has the transcoder read it. The stream's first start after a
   * controller restart takes over the playback the previous run left instead, when there is one
   * (see `SavedPlayback`): nothing starts then, and health counts from when its ffmpeg started.
   */
  private async startPlayback(engine: EngineHandle): Promise<void> {
    const running = await this.record.playback.takeOver(engine, this.now());
    const session = running?.session ?? (await this.record.openSession(engine.baseUrl));
    this.session = session;
    this.attemptStartedAt = running?.startedAt ?? this.now();
    this.stats = running?.stats;
    const { playbackUrl: source, statUrl: stat } = session;
    this.pipeline = running?.pipeline ?? (await this.deps.transcoder.start(this.stream.id, { source, stat }));
    // Once the transcoder reads it.
    await this.record.playback.save(session);
  }

  /** Gives the engine the path for a start attempt, once the gateway's paths are known. */
  private async assignStartPath(engine: EngineHandle): Promise<void> {
    if (!this.paths.known) {
      return;
    }
    await this.record.applyPath(engine, this.paths.forStart(this.stream.path, this.recovery.failures) ?? null);
  }

  private async stopSessionQuietly(): Promise<void> {
    await this.record.playback.stop(this.session);
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
