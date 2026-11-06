import type { Logger } from "@aceswarm/shared/logger";
import type { ContainerDetails, DockerClient } from "./docker.ts";

/**
 * Memory an idle engine uses before it holds any stream data: about 145 MiB with the x86 engine in
 * testing. From there its memory grows by about the stream data it keeps, until its memory cache
 * reaches the cap (ENGINE_MEMORY_CACHE_MB), and then stays flat.
 */
export const IDLE_ENGINE_MEMORY_BYTES = 145 * 1024 * 1024;

/** Memory of one engine container. */
export interface EngineMemory {
  stream: string;
  /** Container name; a stream briefly has two engines while it moves to another network path. */
  engine: string;
  usedBytes: number;
  limitBytes: number;
  /** The engine's memory cache cap (`--memory-cache-limit`); null when it has none. */
  cacheLimitBytes: number | null;
  /**
   * Estimated stream data in the engine's memory cache. Engines don't report it, so this is the
   * memory used above an idle engine's, at most the cap.
   */
  cacheBytes: number;
}

/** The memory cache cap an engine container was started with, from its environment. */
export function engineCacheLimit(env: readonly string[] | null | undefined): number | null {
  const prefix = "ACESWARM_MEMORY_CACHE_BYTES=";
  const value = env?.findLast((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  const bytes = Number(value);
  return bytes > 0 && Number.isSafeInteger(bytes) ? bytes : null;
}

/** Estimated memory cache use: the memory above an idle engine's, at most the cap. */
export function estimateCacheBytes(usedBytes: number, cacheLimitBytes: number | null): number {
  const aboveIdle = Math.max(0, usedBytes - IDLE_ENGINE_MEMORY_BYTES);
  return cacheLimitBytes === null ? aboveIdle : Math.min(aboveIdle, cacheLimitBytes);
}

export interface EngineResourceOptions {
  stack: string;
  /** Called once for every out-of-memory kill seen. */
  onOomKill: (stream: string) => void;
}

/**
 * Samples the memory of every engine of the stack and notices out-of-memory kills, so the
 * dashboards show how close engines run to their limit (ENGINE_MEMORY_MB) and how full their memory
 * cache is. The container runtime
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
        const cacheLimitBytes = engineCacheLimit(details?.Config.Env);
        const cacheBytes = estimateCacheBytes(usage.usedBytes, cacheLimitBytes);
        memory.push({ stream, engine, ...usage, cacheLimitBytes, cacheBytes });
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
