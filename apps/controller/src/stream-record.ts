import type { PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient, EngineSession } from "./acestream.ts";
import type { TranscoderClient } from "./clients.ts";
import type { EnginePaths } from "./engine-paths.ts";
import type { EngineHandle } from "./engines.ts";
import { startSessionOfAnyKind } from "./playback.ts";
import { SavedPlayback } from "./saved-playback.ts";
import type { StreamConfig, StreamStore } from "./stream-store.ts";
import { newestFrame } from "./stream-view.ts";

/**
 * How often a playing stream's last frame time is saved. The UI shows it by the minute, so a
 * controller that died without saving it is at most a minute off.
 */
const FRAME_SAVE_EVERY_MS = 60_000;

export interface StreamRecordDeps {
  ace: AcestreamClient;
  store: StreamStore;
  transcoder: TranscoderClient;
  logger: Logger;
  /** The gateway paths of the stream's own engines. */
  gateway: EnginePaths;
}

/**
 * A stream's config as its supervisor knows it. What the supervisor learns about the stream (the
 * path it plays on, the kind of identifier the engine accepted, the session it plays from, when
 * it last had video) is saved in the stream store.
 */
export class StreamRecord {
  config: StreamConfig;
  /** The session the stream plays from, which a restarted controller takes over. */
  readonly playback: SavedPlayback;
  private readonly deps: StreamRecordDeps;
  /** The last frame time the store has, and when it was last saved there. */
  private savedFrameAt: string | null;
  private frameSavedAt: number | undefined;

  constructor(config: StreamConfig, deps: StreamRecordDeps) {
    this.config = config;
    this.deps = deps;
    this.savedFrameAt = config.lastFrameAt;
    this.playback = new SavedPlayback(config.id, deps, deps.logger);
  }

  /** Takes the config the user changed (its name, say), keeping the newer last frame time. */
  update(config: StreamConfig): void {
    this.config = { ...config, lastFrameAt: newestFrame(config.lastFrameAt, this.config.lastFrameAt) };
  }

  /**
   * Notes the video a pipeline of the stream published, and saves the time of the last frame now
   * and then (see `FRAME_SAVE_EVERY_MS`). Every pipeline starts without any video, so the stream's
   * last frame time is the newest one any of its pipelines reported.
   */
  async sawVideo(pipeline: PipelineStatus | undefined, now: number): Promise<void> {
    this.note(pipeline);
    if (this.frameSavedAt === undefined || now - this.frameSavedAt >= FRAME_SAVE_EVERY_MS) {
      await this.saveLastFrame(now);
    }
  }

  /**
   * The stream stops, or the controller does: saves the time of its last frame, so that a stopped
   * stream still says how long ago it had video, also after a restart. A stream that goes for good
   * (`final`: disabled or removed) first asks for the video its pipeline published since the last
   * check, which can be minutes ago when a long step held the checks up. A stopping controller
   * doesn't wait for another service: its stream plays on, and the next run follows it.
   */
  async saveLastVideo(final: boolean): Promise<void> {
    if (final) {
      this.note(await this.deps.transcoder.status(this.config.id).catch(() => undefined));
    }
    await this.saveLastFrame();
  }

  private note(pipeline: PipelineStatus | undefined): void {
    const lastFrameAt = newestFrame(this.config.lastFrameAt, pipeline?.lastFrameAt ?? null);
    if (lastFrameAt !== this.config.lastFrameAt) {
      this.config = { ...this.config, lastFrameAt };
    }
  }

  private async saveLastFrame(savedAt?: number): Promise<void> {
    const { id, lastFrameAt } = this.config;
    if (lastFrameAt === this.savedFrameAt) {
      return;
    }
    this.frameSavedAt = savedAt;
    try {
      await this.deps.store.update(id, { lastFrameAt });
      this.savedFrameAt = lastFrameAt;
    } catch (error) {
      this.deps.logger.warn({ err: error }, "could not save the stream's last frame time");
    }
  }

  /** Starts an engine session and remembers which kind of identifier the engine accepted. */
  async openSession(baseUrl: string): Promise<EngineSession> {
    const { aceId, aceIdKind } = this.config;
    const { session, kind } = await startSessionOfAnyKind(this.deps.ace, baseUrl, aceId, aceIdKind);
    if (this.config.aceIdKind !== kind) {
      this.deps.logger.info({ kind }, "engine accepted the stream identifier");
      this.config = { ...this.config, aceIdKind: kind };
      await this.deps.store.update(this.config.id, { aceIdKind: kind });
    }
    return session;
  }

  /** Routes an engine of the stream's own through `path` at the gateway, and saves it as the stream's path. */
  async applyPath(engine: EngineHandle, path: string | null): Promise<void> {
    if (path === null) {
      return;
    }
    try {
      await this.deps.gateway.assign(engine.ip, path);
      await this.persistPath(path);
    } catch (error) {
      this.deps.logger.warn({ err: error, path }, "could not assign network path");
    }
  }

  async persistPath(path: string): Promise<void> {
    if (this.config.path === path) {
      return;
    }
    this.config = { ...this.config, path };
    await this.deps.store.update(this.config.id, { path });
  }
}
