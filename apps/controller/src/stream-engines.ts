import type { PeerStats, PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient, EngineSession, EngineStats } from "./acestream.ts";
import type { NetgwClient, TranscoderClient } from "./clients.ts";
import { EnginePaths } from "./engine-paths.ts";
import type { EngineHandle, EngineManager, OnEngineAddress } from "./engines.ts";
import type { ControllerMetrics } from "./metrics.ts";
import { exitedPipeline, waitForHandover, type HandoverTiming } from "./playback.ts";
import { nextRecovery, type RecoveryPolicy, type RecoveryState } from "./recovery.ts";
import type { FailureReport, SharedEngines } from "./shared-engines.ts";
import type { MoveSlots } from "./stream-paths.ts";

export interface StreamEnginesDeps {
  engines: EngineManager;
  ace: AcestreamClient;
  transcoder: TranscoderClient;
  netgw: NetgwClient;
  metrics: ControllerMetrics;
  shared?: SharedEngines | undefined;
  /** Limits how many streams start an engine of their own at once (shared by every stream). */
  policyMoves?: MoveSlots | undefined;
}

/** How a stream moves between kinds of engine; see `moveToWanted`. */
export interface WantedEngineMove {
  /** Engine sharing is on. */
  sharing: boolean;
  /** Failed moves wait like recovery steps do. */
  policy: RecoveryPolicy;
  now: number;
  logger: Logger;
  /** Moves the stream to an engine of the wanted kind on its path (see `move`). */
  move: () => Promise<void>;
}

/** Where the stream plays from once a move succeeded. */
export interface MovedStream {
  engine: EngineHandle;
  session: EngineSession;
  pipeline: PipelineStatus | undefined;
}

export interface EngineMove {
  from: EngineHandle;
  /** The stream's session on `from`, stopped once the move is done. */
  session: EngineSession | undefined;
  target: string;
  /** Moves to the target path's shared engine instead of a new engine of the stream's own. */
  shared: boolean;
  /**
   * With a timing, the transcoder keeps the current picture until the new engine delivers video,
   * and the move fails (leaving the stream where it was) if it doesn't in time.
   */
  handover: HandoverTiming | undefined;
  openSession: (baseUrl: string) => Promise<EngineSession>;
  /** Runs once the stream plays from the new engine, before the old one goes. */
  commit: (moved: MovedStream) => Promise<void>;
}

/**
 * The engines one stream plays from: engines of its own, whose gateway paths it manages, or its
 * place on its path's shared engine (see `SharedEngines`), whose path the shared engines manage.
 */
export class StreamEngines {
  /** The gateway paths of the stream's own engines, by engine address. */
  readonly gateway: EnginePaths;
  private readonly streamId: string;
  private readonly deps: StreamEnginesDeps;
  /** Failed moves to the kind of engine the setting asks for, and when to try again. */
  private wanted: RecoveryState = { failures: 0, lastActionAt: undefined };
  /** The engine the stream last played from (container id). */
  private playedOn: string | undefined;
  private startTried = false;

  constructor(streamId: string, deps: StreamEnginesDeps) {
    this.streamId = streamId;
    this.deps = deps;
    this.gateway = new EnginePaths(deps.netgw);
  }

  /**
   * Adopts the stream's own engine left from a previous run (removing older ones), or creates one,
   * leaving `current` if it is a shared engine (sharing was turned off while the stream had no
   * session). `onAddress` gives the starting engine its path; its other addresses' paths go.
   */
  async startOwn(current: EngineHandle | undefined, onAddress: OnEngineAddress): Promise<EngineHandle> {
    this.startTried = true;
    if (current !== undefined && current.sharedPath !== null) {
      await this.release(current);
    }
    const [newest, ...older] = await this.deps.engines.find(this.streamId);
    for (const engine of older) {
      await this.deps.engines.remove(engine);
    }
    const assign = async (starting: EngineHandle): Promise<void> => {
      await this.gateway.keepOnly(starting.ip);
      await onAddress(starting);
    };
    if (newest !== undefined) {
      return this.deps.engines.revive(newest, assign);
    }
    const engine = await this.deps.engines.create(this.streamId, 1, assign);
    this.deps.metrics.engineStarts.inc({ stream: this.streamId });
    return engine;
  }

  /** Restarts the stream's own engine in place. */
  async restartOwn(engine: EngineHandle, onAddress: OnEngineAddress): Promise<EngineHandle> {
    return this.deps.engines.restart(engine, async (starting) => {
      await this.gateway.keepOnly(starting.ip);
      await onAddress(starting);
    });
  }

  /**
   * The path's shared engine for a start attempt: `current` while it is still that, otherwise the
   * path's engine now (letting go of `current`). Removes the stream's own engines, from before
   * sharing was on.
   */
  async startShared(path: string, current: EngineHandle | undefined): Promise<EngineHandle> {
    this.startTried = true;
    const shared = this.required();
    if (current?.sharedPath === path && shared.isCurrent(current)) {
      // Its session failed to start again, so check that the engine still answers.
      return shared.rejoin(current, this.streamId);
    }
    if (current !== undefined) {
      await this.release(current);
    }
    await this.gateway.dropAll();
    await this.deps.engines.removeAllFor(this.streamId);
    return shared.acquire(path, this.streamId);
  }

  /**
   * A stream on a shared engine failed and its recovery is acting. Returns true when the shared
   * engine is being replaced; false for the stream's own engine.
   */
  reportFailure(engine: EngineHandle, report: Omit<FailureReport, "hadVideo">): boolean {
    const hadVideo = this.playedOn === engine.containerId;
    return (
      engine.sharedPath !== null &&
      this.deps.shared?.reportFailure(engine, this.streamId, { ...report, hadVideo }) === true
    );
  }

  /** The stream's pipeline, its session's stats and its engine's peers, as they are now. */
  async poll(
    engine: EngineHandle,
    session: EngineSession,
    previous: PipelineStatus | undefined,
  ): Promise<{ pipeline: PipelineStatus | undefined; stats: EngineStats | undefined; peers: PeerStats | undefined }> {
    const [pipeline, stats, peers] = await Promise.allSettled([
      this.deps.transcoder.status(this.streamId),
      this.deps.ace.stats(session.statUrl),
      this.deps.netgw.peers(engine.ip),
    ]);
    return {
      // A missing pipeline (for example after a transcoder restart) counts as exited.
      pipeline:
        pipeline.status === "fulfilled" ? (pipeline.value ?? exitedPipeline(previous, "pipeline not found")) : previous,
      stats: stats.status === "fulfilled" ? stats.value : undefined,
      peers: peers.status === "fulfilled" ? peers.value : undefined,
    };
  }

  /** The stream receives video from the engine. */
  played(engine: EngineHandle): void {
    this.playedOn = engine.containerId;
  }

  /** It tried to start an engine, or to take over the one it had. */
  get tried(): boolean {
    return this.startTried;
  }

  /**
   * Moves the stream to the kind of engine the setting asks for, on its current path: to the
   * path's shared engine once sharing is on (or once that engine was replaced), or to an engine of
   * its own once sharing is off. Only a few streams start an engine of their own at once, and a
   * failed move waits before the next try. Returns true when it tried.
   */
  async moveToWanted(engine: EngineHandle, wanted: WantedEngineMove): Promise<boolean> {
    const onShared = engine.sharedPath !== null;
    const stale = onShared && !this.isCurrentShared(engine);
    if (wanted.sharing === onShared && !stale) {
      return false;
    }
    if (wanted.now < nextRecovery(this.wanted, wanted.policy, false).notBefore) {
      return false;
    }
    const slots = wanted.sharing ? undefined : this.deps.policyMoves;
    if (slots?.tryTake() === false) {
      return false;
    }
    const target = wanted.sharing ? "the shared engine" : "an engine of its own";
    wanted.logger.info({ engine: engine.name }, `moving the stream to ${target}`);
    try {
      await wanted.move();
      this.wanted = { failures: 0, lastActionAt: undefined };
    } catch (error) {
      this.wanted = { failures: this.wanted.failures + 1, lastActionAt: wanted.now };
      wanted.logger.warn({ err: error }, `could not move the stream to ${target}`);
    } finally {
      slots?.release();
    }
    return true;
  }

  /** Moves the stream from one engine to another, make-before-break (see `EngineMove`). */
  async move(move: EngineMove): Promise<void> {
    // The engine being started, once it has an address, so a failed move can remove it.
    const starting: { engine: EngineHandle | undefined } = { engine: undefined };
    try {
      const engine = await this.forMove(move.from, move.target, move.shared, starting);
      const session = await move.openSession(engine.baseUrl);
      const source = { source: session.playbackUrl };
      let pipeline: PipelineStatus | undefined;
      if (move.handover === undefined) {
        pipeline = await this.deps.transcoder.start(this.streamId, source);
      } else {
        await this.deps.transcoder.start(this.streamId, source, true);
        pipeline = await waitForHandover(this.deps.transcoder, this.streamId, session.playbackUrl, move.handover);
      }
      // The move is done: a later failure must not remove the engine the stream now plays from.
      starting.engine = undefined;
      await move.commit({ engine, session, pipeline });
      if (move.session !== undefined) {
        await this.deps.ace.stopSession(move.session.commandUrl).catch(() => undefined);
      }
      await this.release(move.from);
    } catch (error) {
      if (starting.engine !== undefined) {
        await this.release(starting.engine).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Whether the engine is the one new sessions on its shared path go to (false for the stream's own). */
  isCurrentShared(engine: EngineHandle): boolean {
    return this.deps.shared?.isCurrent(engine) === true;
  }

  /**
   * An engine on `path` for a move away from `current`: the path's shared engine with `shared`,
   * otherwise a new engine of the stream's own. `starting` holds it as soon as it has an address,
   * so a failed move can let go of it.
   */
  private async forMove(
    current: EngineHandle,
    path: string,
    shared: boolean,
    starting: { engine: EngineHandle | undefined },
  ): Promise<EngineHandle> {
    if (shared) {
      const handle = await this.required().acquire(path, this.streamId);
      starting.engine = handle;
      return handle;
    }
    // A stream coming from a shared engine has no engine of its own: it starts at generation 1.
    const generation = current.sharedPath === null ? current.generation + 1 : 1;
    const next = await this.deps.engines.create(this.streamId, generation, async (handle) => {
      if (starting.engine !== undefined && starting.engine.ip !== handle.ip) {
        // It restarted on a new address while starting: its old one may go to another engine.
        await this.gateway.drop(starting.engine.ip);
      }
      starting.engine = handle;
      await this.gateway.assign(handle.ip, path);
    });
    this.deps.metrics.engineStarts.inc({ stream: this.streamId });
    return next;
  }

  /** Lets go of an engine: leaves a shared one (which goes once nobody uses it), removes its own. */
  async release(engine: EngineHandle): Promise<void> {
    if (engine.sharedPath !== null) {
      await this.deps.shared?.release(engine, this.streamId);
      return;
    }
    await this.gateway.drop(engine.ip);
    await this.deps.engines.remove(engine);
  }

  /** Lets go of every engine of the stream: its place on a shared engine, and its own engines. */
  async releaseAll(engine: EngineHandle | undefined): Promise<void> {
    if (engine !== undefined && engine.sharedPath !== null) {
      await this.deps.shared?.release(engine, this.streamId);
    }
    await this.gateway.dropAll();
    await this.deps.engines.removeAllFor(this.streamId);
  }

  private required(): SharedEngines {
    if (this.deps.shared === undefined) {
      throw new Error("engine sharing is not available");
    }
    return this.deps.shared;
  }
}
