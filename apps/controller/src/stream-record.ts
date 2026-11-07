import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient, EngineSession } from "./acestream.ts";
import type { EnginePaths } from "./engine-paths.ts";
import type { EngineHandle } from "./engines.ts";
import { startSessionOfAnyKind } from "./playback.ts";
import type { StreamConfig, StreamStore } from "./stream-store.ts";

export interface StreamRecordDeps {
  ace: AcestreamClient;
  store: StreamStore;
  logger: Logger;
  /** The gateway paths of the stream's own engines. */
  gateway: EnginePaths;
}

/**
 * A stream's config as its supervisor knows it. What the supervisor learns about the stream (the
 * path it plays on, the kind of identifier the engine accepted) is saved in the stream store.
 */
export class StreamRecord {
  config: StreamConfig;
  private readonly deps: StreamRecordDeps;

  constructor(config: StreamConfig, deps: StreamRecordDeps) {
    this.config = config;
    this.deps = deps;
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
