import type { PeerStats, PipelineStatus, StreamState, StreamView, PathAssignment } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import type { EngineSession, EngineStats } from "./acestream.ts";
import type { EngineHandle } from "./engines.ts";
import { duration, evaluateHealth, type Health } from "./health.ts";
import { sleep } from "./playback.ts";
import { leaveDisallowedPath } from "./policy-move.ts";
import { nextRecovery, type RecoveryAction, type RecoveryPolicy, type RecoveryState } from "./recovery.ts";
import { RecoverySteps } from "./recovery-steps.ts";
import { SourceWait } from "./source-wait.ts";
import { StepLoop } from "./step-loop.ts";
import { StreamEngines, type MovedStream } from "./stream-engines.ts";
import { StreamFailover, type PlayingStream } from "./stream-failover.ts";
import { StreamPaths } from "./stream-paths.ts";
import { StreamRecord } from "./stream-record.ts";
import { streamView } from "./stream-view.ts";
import type { StreamConfig } from "./stream-store.ts";
import type { SupervisorDeps } from "./supervisor-deps.ts";

export type { SupervisorDeps, SupervisorSettings } from "./supervisor-deps.ts";

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
  /** The recovery steps it took, and which of them brought video back. */
  private readonly steps: RecoverySteps;
  private forceRestart = false;
  /** Its own engines (with their gateway paths) or its place on a shared engine, and its standbys. */
  private readonly engines: StreamEngines;
  private bootstrapped = false;
  /** Its hot standbys on the other paths, and failing over to them. */
  private readonly failover: StreamFailover;

  /** Runs its steps, and keeps what the stream shows up to date while one takes long. */
  private readonly loop: StepLoop;

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
    this.steps = new RecoverySteps(stream.id, deps.metrics, () => this.playing());
    this.loop = new StepLoop({
      delayMs: deps.settings.tickMs,
      now: this.now,
      logger: this.logger,
      step: async () => this.tick(),
      observe: async () => this.observe(),
    });
    this.failover = new StreamFailover(this.engines, this.paths, {
      ...deps,
      logger: this.logger,
      now: this.now,
      sleep: this.sleep,
      enabled: () => deps.hotStandby?.() === true,
      sharing: () => this.sharing,
      playing: () => this.playing(),
      sourceStale: () => this.sourceWait.waiting,
      setState: this.setState,
      steps: this.steps,
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

  /**
   * True once the first start attempt finished, so `assignments()` is complete. A run that still
   * waits for the previous one has no engine yet, so it has nothing to assign.
   */
  get settled(): boolean {
    return this.bootstrapped || !this.loop.running || this.loop.waiting;
  }

  /** True once it tried to start an engine (or take over its last one), or doesn't need one. */
  get triedEngine(): boolean {
    return this.engines.tried || !this.loop.running;
  }

  /**
   * Starts supervising. With `previous`, the stream's earlier run being torn down (see `stop`), it
   * waits for that first: the teardown removes every engine, session and pipeline of the stream by
   * its id, and this run would take them over and then lose them.
   */
  start(previous?: Promise<void>): void {
    if (this.loop.running) {
      return;
    }
    if (previous !== undefined) {
      this.logger.info("waiting for the stream's previous run to stop before starting");
      this.setState("starting", "waiting for the previous run to stop");
    }
    this.loop.start(previous);
  }

  /**
   * Stops supervising. With `teardown`, also removes the engine and pipeline, once the step in
   * progress is done. Without, it waits at most `waitMs` for that step: opening a session or a
   * handover can take minutes, and the controller only stops this way to shut down. What the step
   * leaves, the next run takes over.
   */
  async stop(teardown: boolean, waitMs = Infinity): Promise<void> {
    await this.loop.stop(teardown ? Infinity : waitMs);
    // Before the pipeline goes: nobody follows the stream's video from here on.
    await this.record.saveLastVideo(teardown);
    if (teardown) {
      await this.teardown();
    }
  }

  updateConfig(stream: StreamConfig): void {
    this.record.update(stream);
  }

  /**
   * The user asked for a restart. It happens on the next check: a running stream restarts, and one
   * that has no session yet (it is starting, or its last start failed) starts now instead of after
   * the ladder's wait.
   */
  requestRestart(): void {
    this.forceRestart = true;
  }

  view(): StreamView {
    const { state, stateSince, message, pipeline, stats, peers, engine } = this;
    const standbys = this.engines.standbys.view();
    const live = { state, stateSince, message, pipeline, stats, peers, recoveries: this.steps.taken, engine, standbys };
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
      this.startNowIfAsked();
      await this.failover.keepStandbys();
      if (await this.bootstrap()) {
        // A restart asked for while it started changes nothing: the stream just started, and a
        // restart on the next check would replace the engine it started.
        this.forceRestart = false;
      }
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
        await this.poll();
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
      await this.recover(health);
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
    this.steps.played();
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
    await this.runAction("restart-engine", "manual restart", this.state !== "playing");
  }

  /**
   * A restart was asked for while there is no session to restart: the stream starts now, rather than
   * when the ladder's wait after a failed start is over. The ladder starts over from there, like it
   * does when a running stream restarts by hand.
   */
  private startNowIfAsked(): void {
    if (!this.forceRestart) {
      return;
    }
    this.forceRestart = false;
    this.logger.info("manual restart; the stream has no session, starting it now");
    this.recovery = { failures: 0, lastActionAt: undefined };
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

  /** Starts the stream's engine and session. Returns true once the stream started. */
  private async bootstrap(): Promise<boolean> {
    if (this.recovery.lastActionAt !== undefined) {
      const { notBefore } = nextRecovery(this.recovery, this.sourceWait.waits(this.policy), false);
      if (this.now() < notBefore) {
        return false;
      }
    }
    try {
      if (this.paths.noneUsable()) {
        // No engine until there is a path for it: the gateway would only block it.
        this.setState("stalled", this.paths.waitingMessage());
        return false;
      }
      if (this.sharing) {
        return await this.bootstrapShared();
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
      return true;
    } catch (error) {
      this.recovery = { failures: this.recovery.failures + 1, lastActionAt: this.now() };
      this.setState(this.sourceWait.state("error"), describeError(error));
      this.logger.warn({ err: error }, "could not start stream");
      return false;
    } finally {
      this.bootstrapped = true;
    }
  }

  /** Starts the stream on its path's shared engine. Returns true once the stream started. */
  private async bootstrapShared(): Promise<boolean> {
    if (!this.paths.known) {
      // The shared engine to use depends on the path.
      this.setState(this.sourceWait.state("starting"), "waiting for the network gateway");
      return false;
    }
    const path = this.paths.forStart(this.stream.path, this.recovery.failures);
    if (path === undefined) {
      this.setState(this.sourceWait.state("stalled"), this.paths.waitingMessage());
      return false;
    }
    this.setState(this.sourceWait.state("starting"), "starting engine");
    this.engine = await this.engines.startShared(path, this.engine);
    await this.record.persistPath(path);
    this.setState(this.sourceWait.state("starting"), "opening stream");
    await this.startPlayback(this.engine);
    return true;
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

  /**
   * Brings the stream's pipeline, stats and peers up to date, and its standbys' data (see
   * `StepWatch`, which calls it while a step takes long). Public for tests.
   */
  async observe(): Promise<void> {
    await Promise.all([this.poll(), this.engines.standbys.refreshReaders()]);
  }

  private async poll(): Promise<void> {
    const { engine, session, pipeline } = this;
    if (engine === undefined || session === undefined) {
      return;
    }
    const polled = await this.engines.poll(engine, session, pipeline);
    if (this.engine !== engine || this.session !== session || this.pipeline !== pipeline) {
      // The stream moved or restarted meanwhile: what was polled is about what it left.
      return;
    }
    this.pipeline = polled.pipeline;
    // Before the step goes on: a recovery replaces the pipeline, and its video with it.
    await this.record.sawVideo(this.pipeline, this.now());
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
   * Walks the recovery ladder. With a stale source (its broadcast sends nothing new, see
   * `evaluateHealth`), the transcoder already stopped reading it and publishes none of it, and the
   * steps wait longer: each new session or engine is a try to find the broadcast moving again,
   * which only it coming back can make work. A hot standby still takes over, since a standby only
   * counts as hot while its own live edge moves: the broadcast is fine there.
   *
   * With a lagging engine the broadcast is there: a wait for it is over, and the ladder starts
   * over, so the engine is replaced now, not when the wait's next try was due. Should the next
   * engines lag too, the ladder's usual waits, which double, keep them from going back to back.
   */
  private async recover(health: Health): Promise<void> {
    let { reason } = health;
    const lagging = health.lagging === true;
    if (health.state === "stale-source") {
      this.sourceWait.begin(reason, this.pipeline?.liveEdge);
    } else if (lagging && this.sourceWait.back(this.pipeline?.liveEdge)) {
      this.recovery = { failures: 0, lastActionAt: undefined };
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
    // Either kind of stale source wants a new engine: the one it has keeps what it serves.
    const freshEngine = waiting || lagging;
    const decision = nextRecovery(this.recovery, this.sourceWait.waits(this.policy), this.canSwitchPath(), freshEngine);
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
    // The peers and speed it showed were the old engine's; the next check polls the new one's. Not
    // here: the old engine goes once the commit is done, and a poll would hold that up.
    this.stats = undefined;
    this.peers = undefined;
    await this.record.playback.save(moved.session);
    this.attemptStartedAt = this.now();
    await this.record.persistPath(target);
    if (switchingPath) {
      this.lastSwitchAt = this.now();
      this.deps.metrics.pathSwitches.inc({ stream: this.stream.id, from, to: target });
    }
    this.logger.info({ from, to: target, engine: moved.engine.name }, "stream moved to another engine");
  }

  /** Takes a step of the ladder; one without `credit` is only an attempt (see `RecoverySteps.take`). */
  private async runAction(action: RecoveryAction, reason: string, credit = true): Promise<void> {
    const engine = this.engine;
    if (engine === undefined) {
      return;
    }
    this.recovery = { failures: this.recovery.failures + 1, lastActionAt: this.now() };
    this.logger.warn({ action, reason, failures: this.recovery.failures }, "recovering stream");
    this.setState(this.sourceWait.state("recovering"), `${reason}; ${action.replace("-", " ")}`);
    try {
      await this.steps.take(action, async () => this.runStep(action, engine), credit);
    } catch (error) {
      this.setState(this.sourceWait.state("stalled"), `${action.replace("-", " ")} failed: ${describeError(error)}`);
      this.logger.warn({ err: error, action }, "recovery action failed");
    }
  }

  private async runStep(action: RecoveryAction, engine: EngineHandle): Promise<void> {
    if (action === "restart-pipeline") {
      await this.stopSessionQuietly();
      await this.startPlayback(engine);
    } else if (action === "restart-engine") {
      await this.runRestartInPlace(engine);
    } else {
      await this.switchPath(engine);
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
      handover: options.handover
        ? { timeoutMs, pollMs, now: this.now, sleep: this.sleep, starting: this.steps.handingOver }
        : undefined,
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
    // The figures were the session's: until a new one is polled, they are unknown.
    this.stats = undefined;
    this.peers = undefined;
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
