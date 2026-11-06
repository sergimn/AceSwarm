import type { Logger } from "@aceswarm/shared/logger";
import type { ContainerDetails, DockerClient } from "./docker.ts";

/** Memory of one engine container. */
export interface EngineMemory {
  stream: string;
  /** Container name; a stream briefly has two engines while it moves to another network path. */
  engine: string;
  usedBytes: number;
  limitBytes: number;
}

export interface EngineResourceOptions {
  stack: string;
  /** Called once for every out-of-memory kill seen. */
  onOomKill: (stream: string) => void;
}

/**
 * Samples the memory of every engine of the stack and notices out-of-memory kills, so the
 * dashboards show how close engines run to their limit (ENGINE_MEMORY_MB). The container runtime
 * restarts an engine killed this way, which only shows in its inspect data: the last exit time
 * changes and OOMKilled is set.
 */
export class EngineResourceMonitor {
  private readonly docker: DockerClient;
  private readonly options: EngineResourceOptions;
  private readonly logger: Logger;
  private memory: EngineMemory[] = [];
  /** Last exit time seen per container id. */
  private readonly lastExit = new Map<string, string>();

  constructor(docker: DockerClient, options: EngineResourceOptions, logger: Logger) {
    this.docker = docker;
    this.options = options;
    this.logger = logger.child({ component: "engine-resources" });
  }

  latest(): EngineMemory[] {
    return this.memory;
  }

  async sample(): Promise<void> {
    const containers = await this.docker.listContainers({
      "aceswarm.stack": this.options.stack,
      "aceswarm.role": "engine",
    });
    const memory: EngineMemory[] = [];
    const seen = new Set<string>();
    for (const container of containers) {
      seen.add(container.Id);
      const stream = container.Labels["aceswarm.stream"] ?? "";
      const engine = (container.Names[0] ?? container.Id).replace(/^\//, "");
      const details = await this.docker.inspectContainer(container.Id);
      if (details !== undefined) {
        this.checkExit(details, stream, engine);
      }
      if (container.State !== "running") {
        continue;
      }
      const usage = await this.docker.memoryUsage(container.Id);
      if (usage !== undefined) {
        memory.push({ stream, engine, ...usage });
      }
    }
    for (const id of this.lastExit.keys()) {
      if (!seen.has(id)) {
        this.lastExit.delete(id);
      }
    }
    this.memory = memory;
  }

  private checkExit(details: ContainerDetails, stream: string, engine: string): void {
    const finishedAt = details.State.FinishedAt;
    const previous = this.lastExit.get(details.Id);
    this.lastExit.set(details.Id, finishedAt);
    // The first sample of a container only records its last exit, which may predate this process.
    if (previous === undefined || previous === finishedAt || !details.State.OOMKilled) {
      return;
    }
    this.logger.warn(
      { stream, engine, limitMb: this.limitMb(engine) },
      "engine was killed for running out of memory; raise ENGINE_MEMORY_MB, or lower ENGINE_MEMORY_CACHE_MB (set it if it is 0)",
    );
    this.options.onOomKill(stream);
  }

  private limitMb(engine: string): number | undefined {
    const limit = this.memory.find((entry) => entry.engine === engine)?.limitBytes;
    return limit === undefined ? undefined : Math.round(limit / 1024 / 1024);
  }
}
