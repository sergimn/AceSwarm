import type { PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient, EngineSession, EngineStats } from "./acestream.ts";
import type { TranscoderClient } from "./clients.ts";
import type { EngineHandle } from "./engines.ts";
import type { StreamStore } from "./stream-store.ts";

/** The playback a previous run of the controller left running, which a supervisor takes over. */
export interface RunningPlayback {
  session: EngineSession;
  /** The transcoder's pipeline reading the session. */
  pipeline: PipelineStatus;
  stats: EngineStats;
  /**
   * When its ffmpeg started (Unix ms). Health counts from then: a playback that never showed video
   * gets no new startup grace.
   */
  startedAt: number;
}

export interface SavedPlaybackDeps {
  store: StreamStore;
  transcoder: TranscoderClient;
  ace: AcestreamClient;
}

/**
 * The engine session a stream plays from, saved in the stream store, so that a restarted controller
 * takes over the playback rather than starting it again. The engine, the transcoder and their
 * ffmpeg keep running while the controller restarts; a new session would need a new ffmpeg, and
 * players would wait for its first segment.
 */
export class SavedPlayback {
  private readonly streamId: string;
  private readonly deps: SavedPlaybackDeps;
  private readonly logger: Logger;
  private tried = false;

  constructor(streamId: string, deps: SavedPlaybackDeps, logger: Logger) {
    this.streamId = streamId;
    this.deps = deps;
    this.logger = logger;
  }

  /** Saves the session the transcoder reads, or none. Failing to save only matters after a restart. */
  async save(session: EngineSession | undefined): Promise<void> {
    const next = session === undefined ? null : { ...session };
    const current = this.deps.store.get(this.streamId)?.session ?? null;
    if (
      current?.playbackUrl === next?.playbackUrl &&
      current?.statUrl === next?.statUrl &&
      current?.commandUrl === next?.commandUrl
    ) {
      return;
    }
    await this.deps.store.update(this.streamId, { session: next }).catch((error: unknown) => {
      this.logger.warn({ err: error }, "could not remember the stream's session");
    });
  }

  /** Stops the session the stream played from, if it has one, and forgets it. */
  async stop(session: EngineSession | undefined): Promise<void> {
    if (session === undefined) {
      return;
    }
    await this.deps.ace.stopSession(session.commandUrl).catch(() => undefined);
    await this.save(undefined);
  }

  /**
   * The first time only: the playback the previous run left, if the saved session is on `engine`
   * (the engine the stream just took over) and the transcoder's ffmpeg still reads it. Otherwise
   * the saved session is forgotten and stopped, so that no engine keeps downloading it for nobody:
   * on `engine`, only if the engine still knows it; on another engine (a shared engine on another
   * path, say, or one that is gone), in the background and unchecked, since a request to a gone
   * address takes seconds and the stream doesn't wait for it.
   *
   * Throws while the transcoder can't be reached: nothing could start then either, its ffmpeg may
   * well still read the session, and the next call tries again.
   */
  async takeOver(engine: EngineHandle, now: number): Promise<RunningPlayback | undefined> {
    const saved = this.tried ? null : (this.deps.store.get(this.streamId)?.session ?? null);
    if (saved === null) {
      this.tried = true;
      return undefined;
    }
    // A session on another address belongs to another engine, or to one that restarted.
    const onEngine = sameHost(saved.statUrl, engine.baseUrl);
    const pipeline = onEngine ? await this.deps.transcoder.status(this.streamId) : undefined;
    this.tried = true;
    const stats = onEngine ? await this.deps.ace.stats(saved.statUrl).catch(() => undefined) : undefined;
    const problem = onEngine ? adoptionProblem(saved, pipeline, stats) : "the session is on another engine";
    if (problem !== undefined || pipeline === undefined || stats === undefined) {
      this.logger.info({ reason: problem }, "could not take over the running playback; starting the stream");
      if (!onEngine) {
        // Another engine, such as a shared engine on another path, may still pull it. That engine
        // may also be gone, and a request to a gone address takes seconds: the stream doesn't wait.
        void this.deps.ace.stopSession(saved.commandUrl).catch(() => undefined);
      } else if (stats !== undefined) {
        await this.deps.ace.stopSession(saved.commandUrl).catch(() => undefined);
      }
      await this.save(undefined);
      return undefined;
    }
    this.logger.info({ engine: engine.name }, "took over the running playback");
    const startedAt = Date.parse(pipeline.startedAt);
    return { session: saved, pipeline, stats, startedAt: Number.isNaN(startedAt) ? now : Math.min(startedAt, now) };
  }
}

/** Whether two URLs point at the same host and port. */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/** Why a saved session can't be taken over, given what the transcoder and the engine report. */
function adoptionProblem(
  saved: EngineSession,
  pipeline: PipelineStatus | undefined,
  stats: EngineStats | undefined,
): string | undefined {
  if (stats === undefined) {
    return "the engine doesn't know the session";
  }
  if (pipeline === undefined) {
    return "the transcoder has no pipeline for the stream";
  }
  if (pipeline.source !== saved.playbackUrl) {
    return "the transcoder reads another source";
  }
  if (pipeline.pendingSource !== null) {
    // The previous run stopped in the middle of a move or a failover. The transcoder may still cut
    // over to that source, whose engine this run doesn't know (or already removed).
    return "the transcoder is moving to another source";
  }
  return pipeline.state === "exited" ? "the transcoder's ffmpeg exited" : undefined;
}
