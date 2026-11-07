import type { PipelineStatus, StreamState } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import type { EngineSession } from "./acestream.ts";
import type { EngineHandle } from "./engines.ts";
import type { ControllerMetrics } from "./metrics.ts";
import type { OpenSession } from "./standby-engine.ts";
import type { TakenStandby } from "./standby.ts";
import type { MovedStream, StreamEngines } from "./stream-engines.ts";
import type { StreamPaths } from "./stream-paths.ts";

/** A hot standby delivers within seconds; one that doesn't by then isn't waited for any longer. */
const HOT_HANDOVER_TIMEOUT_MS = 30_000;

/** Where a stream plays from right now, as its supervisor knows it. */
export interface PlayingStream {
  engine: EngineHandle | undefined;
  session: EngineSession | undefined;
  pipeline: PipelineStatus | undefined;
  path: string | null;
  /** It played since the supervisor started. */
  playedOnce: boolean;
}

/** What `StreamFailover` needs from the stream's supervisor. */
export interface StreamFailoverHost {
  logger: Logger;
  metrics: ControllerMetrics;
  settings: { handoverTimeoutMs: number; tickMs: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Hot standby is on. */
  enabled: () => boolean;
  /** Engine sharing is on. */
  sharing: () => boolean;
  playing: () => PlayingStream;
  setState: (state: StreamState, message: string | null) => void;
  /** Counts a recovery step in the stream's view. */
  countRecovery: () => void;
  /** The stream plays from the engine it moved to, on `path`. */
  commit: (moved: MovedStream, path: string) => Promise<void>;
  openSession: OpenSession;
}

/**
 * A supervisor's use of its stream's hot standbys (see `StreamStandbys`): keeping them on every
 * check, and failing over to a hot one when the stream stops getting video.
 */
export class StreamFailover {
  private readonly streamId: string;
  private readonly engines: StreamEngines;
  private readonly paths: StreamPaths;
  private readonly host: StreamFailoverHost;

  constructor(streamId: string, engines: StreamEngines, paths: StreamPaths, host: StreamFailoverHost) {
    this.streamId = streamId;
    this.engines = engines;
    this.paths = paths;
    this.host = host;
  }

  /** Keeps the stream's standbys on the other paths (see `StreamStandbys.maintain`). */
  async maintain(): Promise<void> {
    const { paths } = this;
    const { path: current, playedOnce } = this.host.playing();
    await this.engines.standbys.maintain({
      enabled: this.host.enabled(),
      sharing: this.host.sharing(),
      known: paths.known,
      current,
      candidates: paths.standbyCandidates(current),
      usable: (path) => paths.allowed(path) && paths.exists(path),
      up: (path) => !paths.isDown(path),
      mayStart: playedOnce,
      sparePath: this.engines.sparePath,
      openSession: this.host.openSession,
    });
  }

  /** A hot standby is ready to take over. */
  hasHot(): boolean {
    return this.host.enabled() && this.engines.standbys.hasHot(this.eligible);
  }

  /**
   * The stream still counts as playing, but no new video came for `failoverAfterMs` and a standby
   * is hot: it fails over now rather than once the stall shows. Returns true when it tried.
   */
  async failOverEarly(): Promise<boolean> {
    const lastFrameAt = this.host.playing().pipeline?.lastFrameAt;
    if (lastFrameAt === null || lastFrameAt === undefined || !this.hasHot()) {
      return false;
    }
    const quietMs = this.host.now() - Date.parse(lastFrameAt);
    if (quietMs < this.engines.standbys.settings.failoverAfterMs) {
      return false;
    }
    await this.failOver(`no new video for ${String(Math.round(quietMs / 1000))}s; failing over to a standby`);
    return true;
  }

  /**
   * Fails over to the best hot standby, as a recovery step. A failover that fails leaves the stream
   * where it was, and recovery's next step comes on a later check.
   */
  async failOver(reason: string): Promise<void> {
    const { engine } = this.host.playing();
    const standby = engine === undefined ? undefined : this.engines.standbys.takeHot(this.eligible);
    if (engine === undefined || standby === undefined) {
      return;
    }
    this.host.countRecovery();
    this.host.metrics.recoveries.inc({ stream: this.streamId, action: "failover" });
    this.host.logger.warn({ reason, to: standby.path }, "failing over to a standby");
    try {
      await this.moveTo(engine, standby, reason);
    } catch (error) {
      this.host.setState("stalled", `failing over to ${standby.path} failed: ${describeError(error)}`);
      this.host.logger.warn({ err: error, path: standby.path }, "could not fail over to the standby");
    }
  }

  /**
   * A standby for a path move: a hot one on any path the stream may use, or else the one on
   * `target`, hot or not. Undefined when hot standby is off or there is none.
   */
  takeForMove(target: string | undefined): TakenStandby | undefined {
    if (!this.host.enabled()) {
      return undefined;
    }
    const { standbys } = this.engines;
    return standbys.takeHot(this.eligible) ?? (target === undefined ? undefined : standbys.takeOn(target));
  }

  /**
   * Moves the stream to a standby, make-before-break. A hot one delivers within seconds, so it gets
   * a short handover; one still warming up gets the usual one.
   */
  async moveTo(engine: EngineHandle, standby: TakenStandby, reason: string): Promise<void> {
    const { path, session } = this.host.playing();
    this.host.setState("switching", `${reason}; moving from ${path ?? "none"} to ${standby.path}`);
    const { handoverTimeoutMs, tickMs } = this.host.settings;
    const timeoutMs = standby.hot ? Math.min(handoverTimeoutMs, HOT_HANDOVER_TIMEOUT_MS) : handoverTimeoutMs;
    await this.engines.failover({
      from: engine,
      fromPath: path,
      session,
      standby,
      handover: { timeoutMs, pollMs: Math.min(tickMs, 1000), now: this.host.now, sleep: this.host.sleep },
      commit: this.host.commit,
    });
  }

  /**
   * The transcoder already plays from an engine a move kept, or a standby, that the move or
   * failover gave up on: finishes that one. Returns true when the stream moved.
   */
  async finishLateMoves(): Promise<boolean> {
    const { engine, path, session, pipeline } = this.host.playing();
    if (engine === undefined) {
      return false;
    }
    if (await this.engines.finishLateMove(engine, session, pipeline)) {
      return true;
    }
    return this.engines.finishLateFailover({
      from: engine,
      fromPath: path,
      session,
      pipeline,
      commit: this.host.commit,
    });
  }

  /** Paths a standby may take the stream to: another one that is up and allowed. */
  private readonly eligible = (path: string): boolean => {
    const { paths } = this;
    return path !== this.host.playing().path && paths.allowed(path) && !paths.isDown(path);
  };
}
