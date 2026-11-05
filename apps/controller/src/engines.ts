import type { Logger } from "@aceswarm/shared/logger";
import { describeError } from "@aceswarm/shared/http";
import type { AcestreamClient } from "./acestream.ts";
import type { ContainerDetails, DockerClient } from "./docker.ts";

export interface EngineHandle {
  containerId: string;
  name: string;
  streamId: string;
  generation: number;
  ip: string;
  baseUrl: string;
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
  extraFlags: string;
  dns: string;
  readyTimeoutMs: number;
}

const ROLE_LABEL = "aceswarm.role";
const STACK_LABEL = "aceswarm.stack";
const STREAM_LABEL = "aceswarm.stream";
const GENERATION_LABEL = "aceswarm.generation";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Creates one engine container per stream on demand through the Docker socket proxy. Engines are
 * labelled with the stack and stream so the controller can adopt them after a restart and remove
 * orphans. A stream can briefly have two engines (two "generations") while it moves to another
 * network path.
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

  /** Creates and starts an engine, then waits until its HTTP API answers. */
  async create(streamId: string, generation: number, onAddress?: OnEngineAddress): Promise<EngineHandle> {
    const name = `${this.options.stack}-engine-${streamId}-${String(generation)}`;
    const existing = await this.docker.inspectContainer(name);
    if (existing !== undefined) {
      await this.docker.removeContainer(existing.Id);
    }
    const id = await this.docker.createContainer(name, {
      Image: this.options.image,
      Env: [
        `ACESWARM_GATEWAY=${this.options.gatewayIp}`,
        `ACESWARM_DNS=${this.options.dns}`,
        `ACESWARM_ENGINE_FLAGS=${this.options.extraFlags}`,
      ],
      Labels: {
        [STACK_LABEL]: this.options.stack,
        [ROLE_LABEL]: "engine",
        [STREAM_LABEL]: streamId,
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
    this.logger.info({ streamId, generation, container: name }, "engine started");
    return this.waitReady(id, onAddress);
  }

  async restart(handle: EngineHandle, onAddress?: OnEngineAddress): Promise<EngineHandle> {
    this.logger.info({ streamId: handle.streamId, container: handle.name }, "restarting engine");
    await this.docker.restartContainer(handle.containerId);
    return this.waitReady(handle.containerId, onAddress);
  }

  /** Makes sure an adopted engine is running and answering. */
  async revive(handle: EngineHandle, onAddress?: OnEngineAddress): Promise<EngineHandle> {
    const details = await this.docker.inspectContainer(handle.containerId);
    if (details === undefined) {
      throw new Error(`engine ${handle.name} disappeared`);
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

  /** Removes engines of this stack whose stream is no longer configured. */
  async removeOrphans(knownStreamIds: ReadonlySet<string>): Promise<number> {
    const containers = await this.docker.listContainers({
      [STACK_LABEL]: this.options.stack,
      [ROLE_LABEL]: "engine",
    });
    let removed = 0;
    for (const container of containers) {
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
        throw new Error("engine container vanished while starting");
      }
      if (!details.State.Running && details.State.Status === "exited") {
        throw new Error(`engine exited with code ${String(details.State.ExitCode)}`);
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
    throw new Error(`engine did not become ready: ${lastProblem}`);
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
    };
  }
}
