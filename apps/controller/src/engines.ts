import type { Logger } from "@aceswarm/shared/logger";
import { describeError } from "@aceswarm/shared/http";
import type { AcestreamClient } from "./acestream.ts";
import type { ContainerDetails, DockerClient } from "./docker.ts";

/**
 * The engine is gone: its container disappeared or exited, or its API never answered. Unlike an
 * error from the Docker API, which may pass, only a new engine helps.
 */
export class EngineGoneError extends Error {}

export interface EngineHandle {
  containerId: string;
  name: string;
  /** The stream that owns the engine; empty for a shared engine. */
  streamId: string;
  generation: number;
  ip: string;
  baseUrl: string;
  /** The network path of a shared engine, which every stream on that path uses; null for a stream's own engine. */
  sharedPath: string | null;
}

/**
 * Called while an engine starts, as soon as its container has an address and before its API
 * answers. The gateway blocks an engine until it has a network path, and a real engine's API only
 * answers once its first DNS lookups are done, so the path has to be set here: set once the API
 * answers, every start first sat through those lookups timing out. Called again if the address
 * changes; an error stops the start.
 */
export type OnEngineAddress = (engine: EngineHandle) => Promise<void>;

export interface EngineManagerOptions {
  stack: string;
  image: string;
  network: string;
  gatewayIp: string;
  httpPort: number;
  memoryMb: number;
  /** The engine's memory cache limit; 0 leaves it to the engine. */
  memoryCacheMb: number;
  extraFlags: string;
  dns: string;
  readyTimeoutMs: number;
}

/** The environment of an engine container, which its entrypoint and start script read. */
export function engineEnvironment(
  options: Pick<EngineManagerOptions, "gatewayIp" | "dns" | "memoryCacheMb" | "extraFlags">,
): string[] {
  return [
    `ACESWARM_GATEWAY=${options.gatewayIp}`,
    `ACESWARM_DNS=${options.dns}`,
    `ACESWARM_MEMORY_CACHE_BYTES=${String(options.memoryCacheMb * 1024 * 1024)}`,
    `ACESWARM_ENGINE_FLAGS=${options.extraFlags}`,
  ];
}

export const ROLE_LABEL = "aceswarm.role";
export const STACK_LABEL = "aceswarm.stack";
const STREAM_LABEL = "aceswarm.stream";
const GENERATION_LABEL = "aceswarm.generation";
const SHARED_PATH_LABEL = "aceswarm.shared-path";

/** A path id ("direct", "wg:<profile>") as it can appear in a container name. */
function nameSafe(path: string): string {
  return path.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Creates engine containers on demand through the Docker socket proxy: one per stream, or one per
 * network path that every stream on it shares (see `SharedEngines`). Engines are labelled with the
 * stack and their stream or path, so the controller can adopt them after a restart and remove
 * orphans. A stream or path can briefly have two engines (two "generations") while streams move
 * from one to the other.
 */
export class EngineManager {
  private readonly docker: DockerClient;
  private readonly ace: AcestreamClient;
  private readonly options: EngineManagerOptions;
  private readonly logger: Logger;

  constructor(docker: DockerClient, ace: AcestreamClient, options: EngineManagerOptions, logger: Logger) {
    this.docker = docker;
    this.ace = ace;
    this.options = options;
    this.logger = logger.child({ component: "engines" });
  }

  /** Pulls the engine image when it is not on the host yet. */
  async ensureImage(): Promise<void> {
    if (await this.docker.imageExists(this.options.image)) {
      return;
    }
    this.logger.info({ image: this.options.image }, "pulling engine image");
    await this.docker.pullImage(this.options.image);
  }

  /** Engines that already exist for a stream, newest generation first. */
  async find(streamId: string): Promise<EngineHandle[]> {
    const containers = await this.docker.listContainers({
      [STACK_LABEL]: this.options.stack,
      [ROLE_LABEL]: "engine",
      [STREAM_LABEL]: streamId,
    });
    const handles: EngineHandle[] = [];
    for (const container of containers) {
      const details = await this.docker.inspectContainer(container.Id);
      if (details !== undefined) {
        handles.push(this.toHandle(details));
      }
    }
    return handles.toSorted((a, b) => b.generation - a.generation);
  }

  /** The container name of a stream's own engine of that generation. */
  ownName(streamId: string, generation: number): string {
    return `${this.options.stack}-engine-${streamId}-${String(generation)}`;
  }

  /** Creates and starts a stream's own engine, then waits until its HTTP API answers. */
  async create(streamId: string, generation: number, onAddress?: OnEngineAddress): Promise<EngineHandle> {
    const name = this.ownName(streamId, generation);
    const handle = await this.createContainer(name, { [STREAM_LABEL]: streamId }, generation, onAddress);
    this.logger.info({ streamId, generation, container: name }, "engine started");
    return handle;
  }

  /** Creates and starts the shared engine of a network path, then waits until its HTTP API answers. */
  async createShared(path: string, generation: number, onAddress?: OnEngineAddress): Promise<EngineHandle> {
    const name = `${this.options.stack}-engine-shared-${nameSafe(path)}-${String(generation)}`;
    const handle = await this.createContainer(name, { [SHARED_PATH_LABEL]: path }, generation, onAddress);
    this.logger.info({ path, generation, container: name }, "shared engine started");
    return handle;
  }

  /** Shared engines that already exist, newest generation first; all of them, or those of one path. */
  async findShared(path?: string): Promise<EngineHandle[]> {
    const containers = await this.docker.listContainers({
      [STACK_LABEL]: this.options.stack,
      [ROLE_LABEL]: "engine",
      ...(path !== undefined && { [SHARED_PATH_LABEL]: path }),
    });
    const handles: EngineHandle[] = [];
    for (const container of containers) {
      if (container.Labels[SHARED_PATH_LABEL] === undefined) {
        continue;
      }
      const details = await this.docker.inspectContainer(container.Id);
      if (details !== undefined) {
        handles.push(this.toHandle(details));
      }
    }
    return handles.toSorted((a, b) => b.generation - a.generation);
  }

  private async createContainer(
    name: string,
    owner: Record<string, string>,
    generation: number,
    onAddress?: OnEngineAddress,
  ): Promise<EngineHandle> {
    const existing = await this.docker.inspectContainer(name);
    if (existing !== undefined) {
      await this.docker.removeContainer(existing.Id);
    }
    const id = await this.docker.createContainer(name, {
      Image: this.options.image,
      Env: engineEnvironment(this.options),
      Labels: {
        [STACK_LABEL]: this.options.stack,
        [ROLE_LABEL]: "engine",
        ...owner,
        [GENERATION_LABEL]: String(generation),
      },
      HostConfig: {
        NetworkMode: this.options.network,
        // Only used by the entrypoint to point the default route at the gateway; the engine itself
        // runs as an unprivileged user without capabilities.
        CapAdd: ["NET_ADMIN"],
        Init: true,
        RestartPolicy: { Name: "unless-stopped" },
        Memory: this.options.memoryMb * 1024 * 1024,
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
    });
    await this.docker.startContainer(id);
    return this.waitReady(id, onAddress);
  }

  async restart(handle: EngineHandle, onAddress?: OnEngineAddress): Promise<EngineHandle> {
    this.logger.info({ container: handle.name }, "restarting engine");
    await this.docker.restartContainer(handle.containerId);
    return this.waitReady(handle.containerId, onAddress);
  }

  /** Makes sure an adopted engine is running and answering. */
  async revive(handle: EngineHandle, onAddress?: OnEngineAddress): Promise<EngineHandle> {
    const details = await this.docker.inspectContainer(handle.containerId);
    if (details === undefined) {
      throw new EngineGoneError(`engine ${handle.name} disappeared`);
    }
    if (!details.State.Running) {
      await this.docker.startContainer(handle.containerId);
    }
    return this.waitReady(handle.containerId, onAddress);
  }

  async remove(handle: Pick<EngineHandle, "containerId" | "name">): Promise<void> {
    this.logger.info({ container: handle.name }, "removing engine");
    await this.docker.removeContainer(handle.containerId);
  }

  async removeAllFor(streamId: string): Promise<void> {
    const handles = await this.find(streamId);
    for (const handle of handles) {
      await this.remove(handle);
    }
  }

  /**
   * Removes engines of this stack whose stream is no longer configured. Shared engines belong to a
   * path rather than a stream: `SharedEngines` removes the ones nobody uses.
   */
  async removeOrphans(knownStreamIds: ReadonlySet<string>): Promise<number> {
    const containers = await this.docker.listContainers({
      [STACK_LABEL]: this.options.stack,
      [ROLE_LABEL]: "engine",
    });
    let removed = 0;
    for (const container of containers) {
      if (container.Labels[SHARED_PATH_LABEL] !== undefined) {
        continue;
      }
      const streamId = container.Labels[STREAM_LABEL];
      if (streamId !== undefined && knownStreamIds.has(streamId)) {
        continue;
      }
      await this.remove({ containerId: container.Id, name: container.Names[0] ?? container.Id });
      removed += 1;
    }
    return removed;
  }

  private async waitReady(containerId: string, onAddress?: OnEngineAddress): Promise<EngineHandle> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    let lastProblem = "not started";
    let announcedIp = "";
    while (Date.now() < deadline) {
      const details = await this.docker.inspectContainer(containerId);
      if (details === undefined) {
        throw new EngineGoneError("engine container vanished while starting");
      }
      if (!details.State.Running && details.State.Status === "exited") {
        throw new EngineGoneError(`engine exited with code ${String(details.State.ExitCode)}`);
      }
      const handle = this.toHandle(details);
      if (handle.ip.length > 0) {
        if (handle.ip !== announcedIp) {
          announcedIp = handle.ip;
          await onAddress?.(handle);
        }
        try {
          await this.ace.version(handle.baseUrl);
          return handle;
        } catch (error) {
          lastProblem = describeError(error);
        }
      }
      await sleep(1000);
    }
    throw new EngineGoneError(`engine did not become ready: ${lastProblem}`);
  }

  private toHandle(details: ContainerDetails): EngineHandle {
    const ip = details.NetworkSettings.Networks[this.options.network]?.IPAddress ?? "";
    return {
      containerId: details.Id,
      name: details.Name.replace(/^\//, ""),
      streamId: details.Config.Labels[STREAM_LABEL] ?? "",
      generation: Number.parseInt(details.Config.Labels[GENERATION_LABEL] ?? "0", 10),
      ip,
      baseUrl: `http://${ip}:${String(this.options.httpPort)}`,
      sharedPath: details.Config.Labels[SHARED_PATH_LABEL] ?? null,
    };
  }
}
