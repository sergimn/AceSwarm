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
/** How much newer than the stream's last video a standby's data must be, at most, to fail over to it. */
const FRESH_MARGIN_MS = 4000;
/** A stream keeps standbys only while it played within this long. */
const STANDBY_ACTIVE_MS = 10 * 60_000;

/** Where a stream plays from right now, as its supervisor knows it. */
export interface PlayingStream {
  engine: EngineHandle | undefined;
  session: EngineSession | undefined;
  pipeline: PipelineStatus | undefined;
  path: string | null;
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
  /** The stream waits for its broadcast, which sends nothing new (see `StreamSupervisor`). */
  sourceStale: () => boolean;
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
  /** When the stream last got video, as far as this supervisor saw. */
  private lastVideoAt: number | undefined;

  constructor(streamId: string, engines: StreamEngines, paths: StreamPaths, host: StreamFailoverHost) {
    this.streamId = streamId;
    this.engines = engines;
    this.paths = paths;
    this.host = host;
  }

  /** Keeps the stream's standbys on the other paths (see `StreamStandbys.maintain`). */
  async maintain(): Promise<void> {
    const { paths } = this;
    const { path: current, pipeline } = this.host.playing();
    if (pipeline?.lastFrameAt !== null && pipeline?.lastFrameAt !== undefined) {
      this.lastVideoAt = Math.max(this.lastVideoAt ?? 0, Date.parse(pipeline.lastFrameAt));
    }
    await this.engines.standbys.maintain({
      enabled: this.host.enabled(),
      sharing: this.host.sharing(),
      known: paths.known,
      current,
      candidates: paths.standbyCandidates(current),
      usable: (path) => paths.allowed(path) && paths.exists(path),
      up: (path) => !paths.isDown(path),
      // While the broadcast sends nothing new, standbys would only load the same old window: they
      // go, and come back once the stream plays again.
      active:
        !this.host.sourceStale() &&
        this.lastVideoAt !== undefined &&
        this.host.now() - this.lastVideoAt < STANDBY_ACTIVE_MS,
      sparePath: this.engines.sparePath,
      transcoderSources: [pipeline?.source, pipeline?.pendingSource].filter(
        (source): source is string => typeof source === "string" && source !== "",
      ),
      openSession: this.host.openSession,
    });
  }

  /** A hot standby is ready to take over. */
  hasHot(): boolean {
    return this.host.enabled() && this.engines.standbys.hasHot(this.eligible, this.freshAfter());
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
    const standby = engine === undefined ? undefined : this.engines.standbys.takeHot(this.eligible, this.freshAfter());
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
    const hot = standbys.takeHot(this.eligible, this.freshAfter());
    return hot ?? (target === undefined ? undefined : standbys.takeOn(target));
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

  /**
   * A standby counts for a failover only with data newer than the stream's last video, by half the
   * failover delay (at most `FRESH_MARGIN_MS`): one that stopped with the stream (the transcoder restarting, a broadcast that
   * pauses everywhere) would not help. Without the pipeline's status, nothing counts.
   */
  private freshAfter(): number {
    const { pipeline } = this.host.playing();
    if (pipeline === undefined) {
      return Infinity;
    }
    const lastFrameAt = pipeline.lastFrameAt === null ? 0 : Date.parse(pipeline.lastFrameAt);
    return lastFrameAt + Math.min(this.engines.standbys.settings.failoverAfterMs / 2, FRESH_MARGIN_MS);
  }

  /** Paths a standby may take the stream to: another one that is up and allowed. */
  private readonly eligible = (path: string): boolean => {
    const { paths } = this;
    return path !== this.host.playing().path && paths.allowed(path) && !paths.isDown(path);
  };
}
