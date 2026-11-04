import { randomUUID } from "node:crypto";
import type {
  PathStatus,
  PathStrategyName,
  PeerStats,
  PipelineStatus,
  StreamState,
  StreamView,
} from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import { kindsToTry } from "@aceswarm/shared/ace-id";
import { EngineError, type AcestreamClient, type EngineSession, type EngineStats } from "./acestream.ts";
import type { NetgwClient, TranscoderClient } from "./clients.ts";
import type { EngineHandle, EngineManager } from "./engines.ts";
import { evaluateHealth } from "./health.ts";
import type { ControllerMetrics } from "./metrics.ts";
import { initialPath, rememberHealth, switchTarget, type PathMemory } from "./path-selector.ts";
import { nextRecovery, type RecoveryAction, type RecoveryState } from "./recovery.ts";
import type { StreamConfig, StreamStore } from "./stream-store.ts";

export interface SupervisorSettings {
  tickMs: number;
  stallAfterMs: number;
  startupGraceMs: number;
  recoveryBaseDelayMs: number;
  recoveryMaxDelayMs: number;
  handoverTimeoutMs: number;
  pathStrategy: PathStrategyName;
  pathHysteresis: number;
  pathMinDwellMs: number;
}

export interface SupervisorDeps {
  engines: EngineManager;
  ace: AcestreamClient;
  transcoder: TranscoderClient;
  netgw: NetgwClient;
  store: StreamStore;
  metrics: ControllerMetrics;
  logger: Logger;
  settings: SupervisorSettings;
  /** Latest network path status from the gateway (empty when it is unreachable). */
  paths: () => PathStatus[];
  /** Number of running streams per path. */
  pathLoad: () => ReadonlyMap<string, number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Keeps one stream alive: owns its engine, playback session, transcoder pipeline and network
 * path, polls their health and walks the recovery ladder when video stops.
 */
export class StreamSupervisor {
  private stream: StreamConfig;
  private readonly deps: SupervisorDeps;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

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
  private readonly memory: PathMemory = new Map();
  private lastSwitchAt = 0;
  private recoveries = 0;
  private forceRestart = false;

  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private current: Promise<void> = Promise.resolve();

  constructor(stream: StreamConfig, deps: SupervisorDeps) {
    this.stream = stream;
    this.deps = deps;
    this.logger = deps.logger.child({ stream: stream.id, aceId: stream.aceId });
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.stateSince = this.now();
  }

  get id(): string {
    return this.stream.id;
  }

  get path(): string | null {
    return this.stream.path;
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
    const statsPeers = this.stats?.peers;
    return {
      id: this.stream.id,
      aceId: this.stream.aceId,
      aceIdKind: this.stream.aceIdKind,
      name: this.stream.name,
      enabled: this.stream.enabled,
      createdAt: this.stream.createdAt,
      state: this.state,
      stateSince: new Date(this.stateSince).toISOString(),
      message: this.message,
      lastFrameAt: this.pipeline?.lastFrameAt ?? null,
      peers: {
        connected: statsPeers ?? this.peers?.connected ?? null,
        active: this.peers?.active ?? null,
        countries: this.peers?.countries.slice(0, 3) ?? [],
      },
      downloadKBps: this.stats?.speedDown ?? null,
      uploadKBps: this.stats?.speedUp ?? null,
      path: this.stream.path,
      recoveries: this.recoveries,
      hls: hlsUrls(this.stream.id),
    };
  }

  /** Runs a single supervision step. Public for tests; the timer calls it in production. */
  async tick(): Promise<void> {
    if (this.engine === undefined || this.session === undefined) {
      await this.bootstrap();
      return;
    }
    if (this.forceRestart) {
      this.forceRestart = false;
      await this.runAction("restart-engine", "manual restart");
      return;
    }
    await this.poll();
    const health = evaluateHealth({
      now: this.now(),
      attemptStartedAt: this.attemptStartedAt,
      pipeline: this.pipeline,
      engineStatus: this.stats?.status,
      stallAfterMs: this.deps.settings.stallAfterMs,
      startupGraceMs: this.deps.settings.startupGraceMs,
    });
    if (this.stream.path !== null && health.state !== "starting" && health.state !== "buffering") {
      rememberHealth(this.memory, this.stream.path, health.healthy);
    }
    if (health.healthy) {
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
      const { notBefore } = nextRecovery(this.recovery, this.policy(), false);
      if (this.now() < notBefore) {
        return;
      }
    }
    this.setState("starting", "starting engine");
    try {
      const existing = await this.deps.engines.find(this.stream.id);
      const [newest, ...older] = existing;
      for (const engine of older) {
        await this.deps.engines.remove(engine);
      }
      if (newest === undefined) {
        this.engine = await this.deps.engines.create(this.stream.id, 1);
        this.deps.metrics.engineStarts.inc({ stream: this.stream.id });
      } else {
        this.engine = await this.deps.engines.revive(newest);
      }
      const path = initialPath({
        strategy: this.deps.settings.pathStrategy,
        paths: this.deps.paths(),
        memory: this.memory,
        load: this.deps.pathLoad(),
        remembered: this.stream.path,
      });
      await this.applyPath(this.engine, path ?? null);
      this.setState("starting", "opening stream");
      await this.startPlayback(this.engine);
    } catch (error) {
      this.recovery = { failures: this.recovery.failures + 1, lastActionAt: this.now() };
      this.setState("error", describeError(error));
      this.logger.warn({ err: error }, "could not start stream");
    }
  }

  private async poll(): Promise<void> {
    const engine = this.engine;
    const session = this.session;
    if (engine === undefined || session === undefined) {
      return;
    }
    const [pipeline, stats, peers] = await Promise.allSettled([
      this.deps.transcoder.status(this.stream.id),
      this.deps.ace.stats(session.statUrl),
      this.deps.netgw.peers(engine.ip),
    ]);
    if (pipeline.status === "fulfilled") {
      // A missing pipeline (for example after a transcoder restart) counts as exited.
      this.pipeline = pipeline.value ?? exitedPipeline(this.pipeline, "pipeline not found");
    }
    this.stats = stats.status === "fulfilled" ? stats.value : undefined;
    this.peers = peers.status === "fulfilled" ? peers.value : undefined;
  }

  private policy(): { baseDelayMs: number; maxDelayMs: number } {
    return {
      baseDelayMs: this.deps.settings.recoveryBaseDelayMs,
      maxDelayMs: this.deps.settings.recoveryMaxDelayMs,
    };
  }

  private currentPathDown(): boolean {
    const path = this.deps.paths().find((candidate) => candidate.id === this.stream.path);
    return path !== undefined && !path.up;
  }

  private canSwitchPath(): boolean {
    const others = this.deps.paths().filter((path) => path.up && path.id !== this.stream.path);
    if (others.length === 0) {
      return false;
    }
    const dwellOver = this.now() - this.lastSwitchAt >= this.deps.settings.pathMinDwellMs;
    return dwellOver || this.currentPathDown();
  }

  private async recover(reason: string): Promise<void> {
    // A dead path cannot be fixed by restarting things locally: leave it right away.
    if (this.currentPathDown() && this.canSwitchPath()) {
      await this.runAction("switch-path", `${reason}; path ${this.stream.path ?? "?"} is down`);
      return;
    }
    const decision = nextRecovery(this.recovery, this.policy(), this.canSwitchPath());
    const wait = decision.notBefore - this.now();
    if (wait > 0) {
      this.setState("stalled", `${reason}; retrying in ${String(Math.ceil(wait / 1000))}s`);
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
        await this.stopSessionQuietly();
        const restarted = await this.deps.engines.restart(engine);
        if (restarted.ip !== engine.ip) {
          await this.unassignQuietly(engine.ip);
        }
        this.engine = restarted;
        await this.applyPath(restarted, this.stream.path);
        await this.startPlayback(restarted);
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
   * new path and the transcoder only cuts over once it delivers video, then the old engine goes.
   */
  private async switchPath(engine: EngineHandle): Promise<void> {
    const from = this.stream.path ?? "none";
    const target = switchTarget({
      strategy: this.deps.settings.pathStrategy,
      paths: this.deps.paths(),
      memory: this.memory,
      current: from,
      hysteresis: this.currentPathDown() ? 0 : this.deps.settings.pathHysteresis,
    });
    if (target === undefined) {
      this.logger.info({ path: from }, "no better path; restarting engine instead");
      await this.runRestartInPlace(engine);
      return;
    }
    this.setState("switching", `moving from ${from} to ${target}`);
    const next = await this.deps.engines.create(this.stream.id, engine.generation + 1);
    this.deps.metrics.engineStarts.inc({ stream: this.stream.id });
    try {
      await this.deps.netgw.assign({ ip: next.ip, path: target });
      const session = await this.openSession(next.baseUrl);
      await this.deps.transcoder.start(this.stream.id, { source: session.playbackUrl }, true);
      await this.waitForHandover(session.playbackUrl);
      const oldSession = this.session;
      this.engine = next;
      this.session = session;
      this.attemptStartedAt = this.now();
      this.lastSwitchAt = this.now();
      await this.persistPath(target);
      this.deps.metrics.pathSwitches.inc({ stream: this.stream.id, from, to: target });
      this.logger.info({ from, to: target }, "stream moved to a new path");
      if (oldSession !== undefined) {
        await this.deps.ace.stopSession(oldSession.commandUrl).catch(() => undefined);
      }
      await this.unassignQuietly(engine.ip);
      await this.deps.engines.remove(engine);
    } catch (error) {
      await this.unassignQuietly(next.ip);
      await this.deps.engines.remove(next).catch(() => undefined);
      throw error;
    }
  }

  private async runRestartInPlace(engine: EngineHandle): Promise<void> {
    await this.stopSessionQuietly();
    const restarted = await this.deps.engines.restart(engine);
    this.engine = restarted;
    await this.applyPath(restarted, this.stream.path);
    await this.startPlayback(restarted);
  }

  private async waitForHandover(source: string): Promise<void> {
    const deadline = this.now() + this.deps.settings.handoverTimeoutMs;
    while (this.now() < deadline) {
      await this.sleep(this.deps.settings.tickMs);
      const status = await this.deps.transcoder.status(this.stream.id).catch(() => undefined);
      if (status?.source === source && status.lastFrameAt !== null) {
        this.pipeline = status;
        return;
      }
      if (status !== undefined && status.pendingSource !== source && status.source !== source) {
        throw new Error("the new path stopped before delivering video");
      }
    }
    throw new Error("the new path did not deliver video in time");
  }

  private async startPlayback(engine: EngineHandle): Promise<void> {
    const session = await this.openSession(engine.baseUrl);
    this.session = session;
    this.attemptStartedAt = this.now();
    this.stats = undefined;
    this.pipeline = await this.deps.transcoder.start(this.stream.id, { source: session.playbackUrl });
  }

  /**
   * Starts an engine session. A bare 40 character value can be a content ID or an infohash, and
   * the engine rejects the wrong kind quickly, so the other kind is tried next and the one that
   * works is remembered.
   */
  private async openSession(baseUrl: string): Promise<EngineSession> {
    let lastError: unknown;
    for (const kind of kindsToTry(this.stream.aceIdKind)) {
      try {
        const session = await this.deps.ace.startSession(baseUrl, this.stream.aceId, kind, randomUUID());
        if (this.stream.aceIdKind !== kind) {
          this.logger.info({ kind }, "engine accepted the stream identifier");
          this.stream = { ...this.stream, aceIdKind: kind };
          await this.deps.store.update(this.stream.id, { aceIdKind: kind });
        }
        return session;
      } catch (error) {
        if (!(error instanceof EngineError)) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError;
  }

  private async applyPath(engine: EngineHandle, path: string | null): Promise<void> {
    if (path === null) {
      return;
    }
    try {
      await this.deps.netgw.assign({ ip: engine.ip, path });
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

  private async unassignQuietly(ip: string): Promise<void> {
    await this.deps.netgw.unassign(ip).catch(() => undefined);
  }

  private async teardown(): Promise<void> {
    await this.deps.transcoder.stop(this.stream.id).catch(() => undefined);
    await this.stopSessionQuietly();
    if (this.engine !== undefined) {
      await this.unassignQuietly(this.engine.ip);
    }
    await this.deps.engines.removeAllFor(this.stream.id).catch((error: unknown) => {
      this.logger.warn({ err: error }, "could not remove engines");
    });
    this.engine = undefined;
    this.setState("stopped", null);
  }
}

export function hlsUrls(streamId: string): StreamView["hls"] {
  return {
    preview: `/hls/${streamId}/preview/index.m3u8`,
    full: `/hls/${streamId}/full/index.m3u8`,
    thumbnail: `/hls/${streamId}/thumbnail.jpg`,
  };
}

function exitedPipeline(previous: PipelineStatus | undefined, error: string): PipelineStatus | undefined {
  return previous === undefined ? undefined : { ...previous, state: "exited", error };
}
