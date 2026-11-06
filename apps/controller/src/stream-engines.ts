import type { PeerStats, PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient, EngineSession, EngineStats } from "./acestream.ts";
import type { NetgwClient, TranscoderClient } from "./clients.ts";
import { EnginePaths } from "./engine-paths.ts";
import { EngineGoneError, type EngineHandle, type EngineManager, type OnEngineAddress } from "./engines.ts";
import type { ControllerMetrics } from "./metrics.ts";
import { exitedPipeline, waitForHandover, type HandoverTiming } from "./playback.ts";
import { nextRecovery, type RecoveryPolicy, type RecoveryState } from "./recovery.ts";
import type { FailureReport, SharedEngines } from "./shared-engines.ts";
import type { MoveSlots } from "./stream-paths.ts";
import type { StreamStore } from "./stream-store.ts";

export interface StreamEnginesDeps {
  engines: EngineManager;
  /** Remembers the stream's own engine (see `startOwn`). */
  store: StreamStore;
  logger: Logger;
  /** A spare waits through two of the recovery ladder's longest delays (see `move`). */
  settings: { recoveryMaxDelayMs: number };
  ace: AcestreamClient;
  transcoder: TranscoderClient;
  netgw: NetgwClient;
  metrics: ControllerMetrics;
  /** The engines that streams on the same path share, used while sharing is on. */
  shared?: SharedEngines | undefined;
  /**
   * Limits how many streams start an engine of their own at once (shared by every stream), to move
   * off a path the policy turned off or off a shared engine once sharing is off.
   */
  policyMoves?: MoveSlots | undefined;
  /**
   * Limits how many spares there are at once (shared by every stream): each is an engine more. A
   * failed move without a free slot removes its engine. No limit without it.
   */
  spareSlots?: MoveSlots | undefined;
  now?: (() => number) | undefined;
}

/** Moves to the same spare that may fail before it goes (see `StreamEngines.move`). */
const SPARE_MAX_FAILURES = 3;

/**
 * A new engine of the stream's own that a move to `path` started, which answered but didn't
 * deliver video in time. The next move to that path tries it again instead of starting a new
 * engine, which would start from no peers. The session the move opened stays open meanwhile, so
 * the engine keeps its peers.
 */
interface Spare {
  engine: EngineHandle;
  path: string;
  session: EngineSession | undefined;
  /** The failed move's commit, for when its video arrives late (see `finishLateMove`). */
  commit: EngineMove["commit"];
  /** Moves to it that failed. */
  failures: number;
  /** When the last one failed. */
  failedAt: number;
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
  private readonly logger: Logger;
  private readonly now: () => number;
  /** A new engine of its own whose move failed, kept for the next try. */
  private spare: Spare | undefined;
  /** Failed moves to the kind of engine the setting asks for, and when to try again. */
  private wanted: RecoveryState = { failures: 0, lastActionAt: undefined };
  /** The engine the stream last played from (container id). */
  private playedOn: string | undefined;
  private startTried = false;

  constructor(streamId: string, deps: StreamEnginesDeps) {
    this.streamId = streamId;
    this.deps = deps;
    this.logger = deps.logger.child({ stream: streamId });
    this.now = deps.now ?? Date.now;
    this.gateway = new EnginePaths(deps.netgw);
  }

  /**
   * Takes over the stream's own engine, or creates one, leaving `current` if it is a shared engine
   * (sharing was turned off while the stream had no session). The engine taken over is `current`,
   * or else the one the stream store remembers (the one it played from before the controller
   * restarted), or else the newest; its other engines go, a spare included. `onAddress` gives the
   * starting engine its path; its other addresses' paths go.
   */
  async startOwn(current: EngineHandle | undefined, onAddress: OnEngineAddress): Promise<EngineHandle> {
    this.startTried = true;
    const spare = this.clearSpare();
    if (current !== undefined && current.sharedPath !== null) {
      await this.release(current);
    }
    const found = await this.deps.engines.find(this.streamId);
    const wanted = current?.sharedPath === null ? current.name : this.deps.store.get(this.streamId)?.ownEngine;
    const kept = found.find((engine) => engine.name === wanted) ?? found[0];
    for (const engine of found) {
      if (engine !== kept) {
        await this.deps.engines.remove(engine);
      }
    }
    if (spare !== undefined && spare.engine.containerId !== kept?.containerId) {
      await this.gateway.drop(spare.engine.ip);
    } else if (spare?.session !== undefined) {
      // The stream starts a session of its own on it.
      await this.deps.ace.stopSession(spare.session.commandUrl).catch(() => undefined);
    }
    const assign = async (starting: EngineHandle): Promise<void> => {
      await this.gateway.keepOnly(starting.ip);
      await onAddress(starting);
    };
    if (kept !== undefined) {
      return this.remember(await this.deps.engines.revive(kept, assign));
    }
    const engine = await this.deps.engines.create(this.streamId, 1, assign);
    this.deps.metrics.engineStarts.inc({ stream: this.streamId });
    return this.remember(engine);
  }

  /** Restarts the stream's own engine in place. A spare keeps its path. */
  async restartOwn(engine: EngineHandle, onAddress: OnEngineAddress): Promise<EngineHandle> {
    return this.deps.engines.restart(engine, async (starting) => {
      await this.gateway.keepOnly(starting.ip, ...(this.spare === undefined ? [] : [this.spare.engine.ip]));
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
    this.clearSpare();
    await this.gateway.dropAll();
    await this.deps.engines.removeAllFor(this.streamId);
    return this.remember(await shared.acquire(path, this.streamId));
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

  /**
   * The stream receives video from the engine. A spare goes, unless the stream still wants to move
   * to an engine of its own: it plays from a shared engine while sharing is off.
   */
  async played(engine: EngineHandle, sharing: boolean): Promise<void> {
    this.playedOn = engine.containerId;
    if (engine.sharedPath === null || sharing) {
      await this.dropSpare("the stream plays again without it");
    }
  }

  /** Removes the spare once no move tried it again for the spare timeout. */
  async expireSpare(): Promise<void> {
    // A path move during recovery comes back after an engine restart step in between.
    if (this.spare !== undefined && this.now() - this.spare.failedAt >= 2 * this.deps.settings.recoveryMaxDelayMs) {
      await this.dropSpare("no move tried it again in time");
    }
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
    wanted.logger.info({ from: engine.name }, `moving the stream to ${target}`);
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

  /**
   * Moves the stream from one engine to another, make-before-break (see `EngineMove`).
   *
   * A move to a new engine of the stream's own that fails once the engine answers keeps that engine
   * as a spare, with the session the move opened: on a slow swarm a new engine can take minutes to
   * find its peers, so the next move to the same path tries it again rather than a new engine that
   * starts from none. It goes after `SPARE_MAX_FAILURES` failed moves, once it stops answering, or
   * when the stream no longer needs it (see `played`, `expireSpare`). A kept session the transcoder
   * still reads (the old ffmpeg had exited, so there was no picture to keep) gets no second
   * reader: the move waits for it.
   */
  async move(move: EngineMove): Promise<void> {
    // The engine being started, once it has an address, so a failed move can let go of it.
    const starting: { engine: EngineHandle | undefined } = { engine: undefined };
    // The same engine, once it answers.
    let ready: EngineHandle | undefined;
    let opened: EngineSession | undefined;
    try {
      const engine = await this.forMove(move.from, move.target, move.shared, starting);
      ready = engine;
      const reused = await this.spareSession(engine);
      const session = reused ?? (await move.openSession(engine.baseUrl));
      opened = session;
      const source = { source: session.playbackUrl };
      let pipeline: PipelineStatus | undefined;
      if (move.handover === undefined) {
        pipeline = await this.deps.transcoder.start(this.streamId, source);
      } else {
        if (reused === undefined || !(await this.transcoderReads(session))) {
          await this.deps.transcoder.start(this.streamId, source, true);
        }
        pipeline = await waitForHandover(this.deps.transcoder, this.streamId, session.playbackUrl, move.handover);
      }
      // The move is done: a later failure must not remove the engine the stream now plays from.
      starting.engine = undefined;
      if (this.spare?.engine.containerId === engine.containerId) {
        this.clearSpare();
      }
      await this.finish(move, { engine, session, pipeline });
    } catch (error) {
      if (starting.engine !== undefined) {
        await this.abandon(ready ?? starting.engine, ready !== undefined, opened, move);
      }
      throw error;
    }
  }

  /**
   * The transcoder plays from the spare: a move to it failed after the old ffmpeg had exited, so
   * the new source became the transcoder's only one and it went on reading it, and video arrived
   * after the move gave up. Finishes that move, leaving `from` and its `session`. Returns true then.
   */
  async finishLateMove(
    from: EngineHandle,
    session: EngineSession | undefined,
    pipeline: PipelineStatus | undefined,
  ): Promise<boolean> {
    const spare = this.spare;
    const kept = spare?.session;
    if (
      spare === undefined ||
      kept === undefined ||
      pipeline?.source !== kept.playbackUrl ||
      pipeline.lastFrameAt === null
    ) {
      return false;
    }
    this.logger.info({ engine: spare.engine.name }, "video arrived late from the kept engine; moving to it");
    this.clearSpare();
    await this.finish({ from, session, commit: spare.commit }, { engine: spare.engine, session: kept, pipeline });
    return true;
  }

  /** Whether the transcoder's current ffmpeg still reads the session (an engine allows one reader). */
  private async transcoderReads(session: EngineSession): Promise<boolean> {
    const status = await this.deps.transcoder.status(this.streamId).catch(() => undefined);
    return status?.source === session.playbackUrl && status.state !== "exited";
  }

  /** The stream plays from the engine it moved to: commits the move and lets go of `from`. */
  private async finish(move: Pick<EngineMove, "from" | "session" | "commit">, moved: MovedStream): Promise<void> {
    // First, so that a restarted controller takes over the engine the transcoder already plays from.
    await this.remember(moved.engine);
    await move.commit(moved);
    if (move.session !== undefined) {
      await this.deps.ace.stopSession(move.session.commandUrl).catch(() => undefined);
    }
    // A move can end on the shared engine the stream came from (it was current again).
    if (moved.engine.containerId !== move.from.containerId) {
      await this.release(move.from);
    }
  }

  /**
   * A move to `engine` failed before the stream played from it: lets go of it. A shared engine
   * stays for other streams, so the session nobody reads stops. A new engine of the stream's own
   * that `answered` stays as the spare, until too many moves to it failed.
   */
  private async abandon(
    engine: EngineHandle,
    answered: boolean,
    session: EngineSession | undefined,
    move: EngineMove,
  ): Promise<void> {
    if (engine.containerId === move.from.containerId) {
      // A move to the shared engine the stream is on (it was current again): it stays there.
      if (session !== undefined) {
        await this.deps.ace.stopSession(session.commandUrl).catch(() => undefined);
      }
      return;
    }
    if (engine.sharedPath !== null) {
      if (session !== undefined) {
        await this.deps.ace.stopSession(session.commandUrl).catch(() => undefined);
      }
      await this.release(engine).catch(() => undefined);
      return;
    }
    const spare = this.spare?.engine.containerId === engine.containerId ? this.spare : undefined;
    const failures = (spare?.failures ?? 0) + 1;
    // A new spare needs a slot; the spare being tried again has one.
    if (
      answered &&
      failures < SPARE_MAX_FAILURES &&
      (spare !== undefined || this.deps.spareSlots?.tryTake() !== false)
    ) {
      this.spare = { engine, path: move.target, session, commit: move.commit, failures, failedAt: this.now() };
      this.logger.info({ engine: engine.name, failures }, "keeping the new engine to try again on it");
      return;
    }
    if (spare !== undefined) {
      this.clearSpare();
    }
    if (answered) {
      this.logger.info({ engine: engine.name, failures }, "removing the new engine after its move failed");
    }
    await this.release(engine).catch(() => undefined);
  }

  /**
   * The spare's session, for a move to the spare, while the engine still knows it. One opened on an
   * address the engine no longer has is gone with that address.
   */
  private async spareSession(engine: EngineHandle): Promise<EngineSession | undefined> {
    const spare = this.spare;
    if (spare?.engine.containerId !== engine.containerId || spare.session === undefined) {
      return undefined;
    }
    const session = spare.session;
    spare.session = undefined;
    if (new URL(session.statUrl).hostname !== new URL(engine.baseUrl).hostname) {
      return undefined;
    }
    try {
      await this.deps.ace.stats(session.statUrl);
      return session;
    } catch {
      await this.deps.ace.stopSession(session.commandUrl).catch(() => undefined);
      return undefined;
    }
  }

  /**
   * The spare, for a move to `path`, once it answers. A spare on another path goes, and so does
   * one that is gone or doesn't answer; other errors (the Docker API failing for a moment) leave it
   * for the next try.
   */
  private async takeSpare(
    path: string,
    starting: { engine: EngineHandle | undefined },
  ): Promise<EngineHandle | undefined> {
    const spare = this.spare;
    if (spare === undefined) {
      return undefined;
    }
    if (spare.path !== path) {
      await this.dropSpare(`the stream moves to ${path} instead`);
      return undefined;
    }
    try {
      const engine = await this.deps.engines.revive(spare.engine, async (handle) => {
        if (handle.ip !== spare.engine.ip) {
          // It restarted on a new address: its old one may go to another engine.
          await this.gateway.drop(spare.engine.ip);
          spare.engine = handle;
        }
        starting.engine = handle;
        await this.gateway.assign(handle.ip, path);
      });
      spare.engine = engine;
      this.logger.info({ engine: engine.name, failures: spare.failures }, "trying the kept engine again");
      return engine;
    } catch (error) {
      starting.engine = undefined;
      if (!(error instanceof EngineGoneError)) {
        throw error;
      }
      await this.dropSpare(`it stopped answering: ${error.message}`);
      return undefined;
    }
  }

  /** Forgets the spare, freeing its slot, and returns it; its engine is left alone. */
  private clearSpare(): Spare | undefined {
    const spare = this.spare;
    if (spare !== undefined) {
      this.spare = undefined;
      this.deps.spareSlots?.release();
    }
    return spare;
  }

  /** Removes the spare, if there is one. */
  private async dropSpare(why: string): Promise<void> {
    const spare = this.clearSpare();
    if (spare === undefined) {
      return;
    }
    this.logger.info({ engine: spare.engine.name, reason: why }, "removing the kept engine");
    await this.gateway.drop(spare.engine.ip);
    await this.deps.engines.remove(spare.engine).catch((error: unknown) => {
      this.logger.warn({ err: error, engine: spare.engine.name }, "could not remove the kept engine");
    });
  }

  /**
   * Saves the name of the stream's own engine it plays from (none on a shared engine) in the stream
   * store, so that a restarted controller takes over that one rather than a spare. Returns the engine.
   * Failing to save only matters after a restart, so it doesn't fail the start or move.
   */
  private async remember(engine: EngineHandle): Promise<EngineHandle> {
    const ownEngine = engine.sharedPath === null ? engine.name : null;
    if (this.deps.store.get(this.streamId)?.ownEngine !== ownEngine) {
      await this.deps.store.update(this.streamId, { ownEngine }).catch((error: unknown) => {
        this.logger.warn({ err: error }, "could not remember the stream's engine");
      });
    }
    return engine;
  }

  /** Whether the engine is the one new sessions on its shared path go to (false for the stream's own). */
  isCurrentShared(engine: EngineHandle): boolean {
    return this.deps.shared?.isCurrent(engine) === true;
  }

  /**
   * An engine on `path` for a move away from `current`: the path's shared engine with `shared`,
   * otherwise the engine an earlier move to `path` kept, or else a new engine of the stream's own.
   * `starting` holds it as soon as it has an address, so a failed move can let go of it.
   */
  private async forMove(
    current: EngineHandle,
    path: string,
    shared: boolean,
    starting: { engine: EngineHandle | undefined },
  ): Promise<EngineHandle> {
    if (shared) {
      await this.dropSpare("the stream moves to the shared engine");
      const handle = await this.required().acquire(path, this.streamId);
      starting.engine = handle;
      return handle;
    }
    const spare = await this.takeSpare(path, starting);
    if (spare !== undefined) {
      return spare;
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
      await this.deps.shared?.release(engine, this.streamId, this.playedOn === engine.containerId);
      return;
    }
    await this.gateway.drop(engine.ip);
    await this.deps.engines.remove(engine);
  }

  /** Lets go of every engine of the stream: its place on a shared engine, and its own engines. */
  async releaseAll(engine: EngineHandle | undefined): Promise<void> {
    if (engine !== undefined && engine.sharedPath !== null) {
      await this.deps.shared?.release(engine, this.streamId, this.playedOn === engine.containerId);
    }
    this.clearSpare();
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
