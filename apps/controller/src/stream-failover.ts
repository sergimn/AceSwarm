import type { PipelineStatus, StreamState } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import type { EngineSession } from "./acestream.ts";
import type { EngineHandle } from "./engines.ts";
import { lastSignOfVideo } from "./health.ts";
import type { RecoverySteps } from "./recovery-steps.ts";
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
  settings: { handoverTimeoutMs: number; tickMs: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Hot standby is on. */
  enabled: () => boolean;
  /** Engine sharing is on. */
  sharing: () => boolean;
  playing: () => PlayingStream;
  /** The state the stream shows. */
  state: () => StreamState;
  /** The stream waits for its broadcast, which sends nothing new (see `StreamSupervisor`). */
  sourceStale: () => boolean;
  setState: (state: StreamState, message: string | null) => void;
  /** The stream's recovery steps, which a failover is one of. */
  steps: RecoverySteps;
  /** The stream plays from the engine it moved to, on `path`. */
  commit: (moved: MovedStream, path: string) => Promise<void>;
  openSession: OpenSession;
}

/**
 * A supervisor's use of its stream's hot standbys (see `StreamStandbys`): keeping them on every
 * check, and failing over to a hot one when the stream stops getting video.
 */
export class StreamFailover {
  private readonly engines: StreamEngines;
  private readonly paths: StreamPaths;
  private readonly host: StreamFailoverHost;
  /** When the stream last got video, as far as this supervisor saw. */
  private lastVideoAt: number | undefined;

  constructor(engines: StreamEngines, paths: StreamPaths, host: StreamFailoverHost) {
    this.engines = engines;
    this.paths = paths;
    this.host = host;
  }

  /** Keeps the stream's standbys on the other paths (see `StreamStandbys.maintain`). */
  async maintain(): Promise<void> {
    await this.check(this.paths.known);
  }

  /**
   * A check for a stream that plays from no session (it is starting, or waits for a path): drops the
   * standbys it no longer wants and learns which are hot, but starts and changes none, since where
   * the stream plays from is not settled.
   */
  async keepStandbys(): Promise<void> {
    try {
      await this.check(false);
    } catch (error) {
      // It runs before the start, which it must not hold up.
      this.host.logger.warn({ err: error }, "could not keep the standbys of a stream that has no session");
    }
  }

  private async check(known: boolean): Promise<void> {
    const { paths } = this;
    const { path: current, pipeline } = this.host.playing();
    if (pipeline?.lastFrameAt !== null && pipeline?.lastFrameAt !== undefined) {
      this.lastVideoAt = Math.max(this.lastVideoAt ?? 0, Date.parse(pipeline.lastFrameAt));
    }
    await this.engines.standbys.maintain({
      enabled: this.host.enabled(),
      sharing: this.host.sharing(),
      known,
      current,
      candidates: paths.standbyCandidates(current),
      favourite: this.favourite(current),
      usable: (path) => paths.allowed(path) && paths.exists(path),
      up: (path) => !paths.isDown(path),
      // While the broadcast sends nothing new, standbys would only load the same old window: they
      // go, and come back once the stream plays again.
      active:
        !this.host.sourceStale() &&
        this.lastVideoAt !== undefined &&
        this.host.now() - this.lastVideoAt < STANDBY_ACTIVE_MS,
      sparePath: this.engines.kept?.path,
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
    // A layout change of the broadcast counts as its video (see `lastSignOfVideo`): the standbys
    // read the same broadcast, so a move would not bring the picture back any sooner.
    const lastVideoAt = lastSignOfVideo(this.host.playing().pipeline);
    if (lastVideoAt === undefined || !this.hasHot()) {
      return false;
    }
    const quietMs = this.host.now() - lastVideoAt;
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
    this.host.logger.warn({ reason, to: standby.path }, "failing over to a standby");
    try {
      await this.host.steps.take("failover", async () => this.moveTo(engine, standby, reason));
    } catch (error) {
      const state = this.host.sourceStale() ? "stale-source" : "stalled";
      this.host.setState(state, `failing over to ${standby.path} failed: ${describeError(error)}`);
      this.host.logger.warn({ err: error, path: standby.path }, "could not fail over to the standby");
    }
  }

  /**
   * Moves the stream to the favourite path once its standby there is stable (see
   * `StreamStandbys.takeStable`), make-before-break like a failover. This is no recovery, and it
   * does not wait for `PATH_MIN_DWELL_SECONDS`: the stream may play fine where it is, so it keeps
   * the state it shows while it moves. A move that fails leaves it where it was, and the standby has
   * to be stable again, after a wait. Returns true when it tried.
   */
  async moveToFavourite(): Promise<boolean> {
    const { engine, path } = this.host.playing();
    const favourite = this.favourite(path);
    if (engine === undefined || favourite === undefined || !this.host.enabled()) {
      return false;
    }
    const standby = this.engines.standbys.takeStable(favourite);
    if (standby === undefined) {
      return false;
    }
    this.host.logger.info({ from: path, to: favourite }, "the favourite path is stable; moving the stream to it");
    try {
      await this.handOver(engine, standby, this.host.state(), "moving to the favourite path");
    } catch (error) {
      this.host.logger.warn({ err: error, path: favourite }, "could not move the stream to the favourite path");
    }
    return true;
  }

  /** The favourite path while a stream on `current` is to move there: it is another path it may use, and up. */
  private favourite(current: string | null): string | undefined {
    const favourite = this.paths.favourite();
    return favourite === current ? undefined : favourite;
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
    await this.handOver(engine, standby, this.host.sourceStale() ? "stale-source" : "switching", reason);
  }

  /** Hands the stream over to a standby, showing `state` and why meanwhile. */
  private async handOver(
    engine: EngineHandle,
    standby: TakenStandby,
    state: StreamState,
    reason: string,
  ): Promise<void> {
    const { path, session } = this.host.playing();
    this.host.setState(state, `${reason}; moving from ${path ?? "none"} to ${standby.path}`);
    const { handoverTimeoutMs, tickMs } = this.host.settings;
    const timeoutMs = standby.hot ? Math.min(handoverTimeoutMs, HOT_HANDOVER_TIMEOUT_MS) : handoverTimeoutMs;
    const { now, sleep, steps } = this.host;
    await this.engines.failover({
      from: engine,
      fromPath: path,
      session,
      standby,
      handover: { timeoutMs, pollMs: Math.min(tickMs, 1000), now, sleep, starting: steps.handingOver },
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
    try {
      return (
        (await this.engines.finishLateMove(engine, session, pipeline)) ||
        (await this.engines.finishLateFailover({
          from: engine,
          fromPath: path,
          session,
          pipeline,
          commit: this.host.commit,
        }))
      );
    } finally {
      // Also when letting go of the engine it left failed afterwards: the stream moved all the same.
      const moved = this.host.playing().session;
      if (moved !== undefined && moved !== session) {
        this.host.steps.arrivedLate(moved);
      }
    }
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
    return (
      (lastSignOfVideo(pipeline) ?? 0) + Math.min(this.engines.standbys.settings.failoverAfterMs / 2, FRESH_MARGIN_MS)
    );
  }

  /** Paths a standby may take the stream to: another one that is up and allowed. */
  private readonly eligible = (path: string): boolean => {
    const { paths } = this;
    return path !== this.host.playing().path && paths.allowed(path) && !paths.isDown(path);
  };
}
