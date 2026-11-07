import type { StandbyState } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient, EngineSession } from "./acestream.ts";
import type { EnginePaths } from "./engine-paths.ts";
import { EngineGoneError, type EngineHandle, type EngineManager } from "./engines.ts";
import type { ControllerMetrics } from "./metrics.ts";
import type { SharedEngines } from "./shared-engines.ts";

/** What one standby needs; `StreamStandbys` shares these between a stream's standbys. */
export interface StandbyEngineDeps {
  streamId: string;
  engines: EngineManager;
  ace: AcestreamClient;
  metrics: ControllerMetrics;
  logger: Logger;
  /** The gateway paths of the standbys' own engines. */
  gateway: EnginePaths;
  shared?: SharedEngines | undefined;
  /** A generation number no other engine of the stream has (see `StreamEngines`). */
  nextGeneration: () => number;
  now: () => number;
}

export type OpenSession = (baseUrl: string) => Promise<EngineSession>;

/**
 * One hot standby of a stream: an engine of the stream's own on another network path, or with
 * engine sharing on, a session on that path's shared engine. `StreamStandbys` decides when it
 * starts, starts again and goes; this does the work.
 */
export class StandbyEngine {
  readonly path: string;
  /** A session on the path's shared engine, rather than an engine of the stream's own. */
  readonly shared: boolean;
  /** Once its API answers. */
  engine: EngineHandle | undefined;
  session: EngineSession | undefined;
  /** When its session opened (or a failed failover gave it a new start). */
  openedAt: number | undefined;
  /** When the transcoder's reader last got data from its session. */
  lastDataAt: number | undefined;
  /** It received data since its session opened. */
  played = false;
  /** Starting, opening its session or starting again, in the background. */
  busy = false;
  /** Failed tries since it was last hot. */
  failures = 0;
  /** No new try before this time. */
  retryAt = 0;
  /** A failover to it failed: no other one before this time. */
  blockedUntil = 0;
  failedFailovers = 0;
  /** Since when its path is down. */
  downSince: number | undefined;
  /** It went while busy: whatever its background work leaves is removed once that ends. */
  dropped = false;
  /** An engine of its own: its generation, reserved as soon as it starts. */
  private generation: number | undefined;
  /** The address the gateway routes through the path (an engine of its own). */
  private ip: string | undefined;
  private readonly deps: StandbyEngineDeps;

  constructor(path: string, shared: boolean, deps: StandbyEngineDeps) {
    this.path = path;
    this.shared = shared;
    this.deps = deps;
  }

  /** An engine of the stream's own that already runs, with its path at the gateway. */
  static adopted(path: string, engine: EngineHandle, deps: StandbyEngineDeps): StandbyEngine {
    const standby = new StandbyEngine(path, false, deps);
    standby.engine = engine;
    standby.generation = engine.generation;
    standby.ip = engine.ip;
    deps.gateway.adopt(engine.ip, path);
    return standby;
  }

  isHot(hotWithinMs: number): boolean {
    return (
      this.session !== undefined && this.lastDataAt !== undefined && this.deps.now() - this.lastDataAt <= hotWithinMs
    );
  }

  state(hotWithinMs: number): StandbyState {
    if (this.isHot(hotWithinMs)) {
      return "hot";
    }
    if (!this.busy && this.failures > 0 && this.deps.now() < this.retryAt) {
      return "failed";
    }
    return this.session === undefined ? "starting" : "warming";
  }

  /** Whether the engine is this standby's, or the one it is starting. */
  owns(engine: EngineHandle): boolean {
    return this.engine?.containerId === engine.containerId || (!this.shared && this.generation === engine.generation);
  }

  /** Starts its engine (or joins the path's shared engine), then opens its session. */
  async start(openSession: OpenSession): Promise<void> {
    if (this.shared) {
      this.engine = await this.requiredShared().acquire(this.path, this.deps.streamId, "standby");
    } else {
      await this.startOwnEngine();
    }
    if (!this.dropped) {
      await this.open(openSession);
    }
  }

  /** Opens its session on its engine. An engine of its own that doesn't answer goes. */
  async open(openSession: OpenSession): Promise<void> {
    const engine = this.engine;
    if (engine === undefined) {
      return;
    }
    try {
      this.session = await openSession(engine.baseUrl);
    } catch (error) {
      if (!this.shared && !(await this.answers(engine))) {
        await this.forgetOwnEngine(engine.containerId);
      }
      throw error;
    }
    this.openedAt = this.deps.now();
    this.lastDataAt = undefined;
    this.played = false;
    this.deps.logger.info({ path: this.path, engine: engine.name }, "standby session open; waiting for data");
  }

  /**
   * It brought no data: an engine of its own starts again; on a shared engine, only its session
   * does (other streams play from that engine).
   */
  async startAgain(openSession: OpenSession): Promise<void> {
    const engine = this.engine;
    if (engine === undefined) {
      return;
    }
    await this.stopSession();
    if (this.shared) {
      if (this.deps.shared?.isCurrent(engine) !== true) {
        // Replaced meanwhile: the next check drops it.
        return;
      }
      // Maybe no stream plays from the engine, and then nothing noticed if it stopped or hangs:
      // checks it, which starts it again or gets the path a new one. After a failed check the
      // standby has no engine, and its next try acquires the path's engine again.
      this.engine = undefined;
      this.engine = await this.requiredShared().rejoin(engine, this.deps.streamId, "standby");
    } else {
      try {
        this.engine = await this.deps.engines.restart(engine, async (handle) => {
          await this.route(handle.ip);
        });
      } catch (error) {
        if (error instanceof EngineGoneError) {
          await this.forgetOwnEngine(engine.containerId);
        }
        throw error;
      }
    }
    if (!this.dropped) {
      await this.open(openSession);
    }
  }

  /** Removes it: its session, and its engine or its place on the shared engine. */
  async dispose(why: string): Promise<void> {
    await this.stopSession();
    const engine = this.engine;
    this.engine = undefined;
    if (this.shared) {
      if (engine !== undefined) {
        await this.deps.shared?.releaseStandby(engine, this.deps.streamId, this.played).catch(() => undefined);
      }
    } else if (engine !== undefined) {
      await this.forgetOwnEngine(engine.containerId);
    } else if (this.generation !== undefined) {
      await this.forgetOwnEngine(this.deps.engines.ownName(this.deps.streamId, this.generation));
    }
    if (engine !== undefined) {
      this.deps.logger.info({ path: this.path, engine: engine.name, reason: why }, "removed the standby");
    }
  }

  /** The stream plays from its engine now: the engine's address leaves the standbys' gateway list. */
  promoted(): void {
    if (this.ip === undefined) {
      return;
    }
    this.deps.gateway.forget(this.ip);
    this.ip = undefined;
  }

  async stopSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session !== undefined) {
      await this.deps.ace.stopSession(session.commandUrl).catch(() => undefined);
    }
  }

  private async startOwnEngine(): Promise<void> {
    const generation = this.deps.nextGeneration();
    this.generation = generation;
    try {
      this.engine = await this.deps.engines.create(this.deps.streamId, generation, async (handle) => {
        await this.route(handle.ip);
      });
    } catch (error) {
      // A container that never answered is left behind by the start.
      await this.forgetOwnEngine(this.deps.engines.ownName(this.deps.streamId, generation));
      throw error;
    }
    this.deps.metrics.engineStarts.inc({ stream: this.deps.streamId });
    if (this.ip !== this.engine.ip) {
      await this.route(this.engine.ip);
    }
  }

  /** Removes the container of its own engine, and its path at the gateway; the next try starts a new one. */
  private async forgetOwnEngine(idOrName: string): Promise<void> {
    this.engine = undefined;
    // `owns` knows the container by its generation until it is gone: removing it takes a while.
    const { generation } = this;
    if (this.ip !== undefined) {
      await this.deps.gateway.drop(this.ip);
      this.ip = undefined;
    }
    await this.deps.engines.remove({ containerId: idOrName, name: idOrName }).catch((error: unknown) => {
      this.deps.logger.warn({ err: error, engine: idOrName }, "could not remove a standby engine");
    });
    if (this.generation === generation) {
      this.generation = undefined;
    }
  }

  private async route(ip: string): Promise<void> {
    if (this.ip !== undefined && this.ip !== ip) {
      await this.deps.gateway.drop(this.ip);
    }
    this.ip = ip;
    await this.deps.gateway.assign(ip, this.path);
  }

  private async answers(engine: EngineHandle): Promise<boolean> {
    try {
      await this.deps.ace.version(engine.baseUrl);
      return true;
    } catch {
      return false;
    }
  }

  private requiredShared(): SharedEngines {
    if (this.deps.shared === undefined) {
      throw new Error("engine sharing is not available");
    }
    return this.deps.shared;
  }
}
