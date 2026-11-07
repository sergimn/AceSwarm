import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { ContainerDetails, ContainerSummary, DockerClient, MemoryUsage } from "../src/docker.ts";
import {
  engineCacheLimit,
  ENGINE_LOADING_MS,
  EngineResourceMonitor,
  estimateCacheBytes,
  IDLE_ENGINE_MEMORY_BYTES,
} from "../src/engine-resources.ts";

interface FakeEngine {
  id: string;
  stream: string;
  running: boolean;
  finishedAt: string;
  oomKilled: boolean;
  memory: MemoryUsage | undefined;
  env?: string[] | null;
  startedAt?: string;
}

const MB = 1024 * 1024;

const NEVER = "0001-01-01T00:00:00Z";

function engine(id: string, stream: string, usedMb: number): FakeEngine {
  return {
    id,
    stream,
    running: true,
    finishedAt: NEVER,
    oomKilled: false,
    memory: { usedBytes: usedMb * 1024 * 1024, limitBytes: 768 * 1024 * 1024 },
  };
}

/** Answers the three Docker calls the monitor makes from a list of fake engines. */
function fakeDocker(engines: FakeEngine[]): DockerClient {
  const fake = {
    listContainers: (): Promise<ContainerSummary[]> =>
      Promise.resolve(
        engines.map((entry) => ({
          Id: entry.id,
          Names: [`/aceswarm-engine-${entry.stream}-1`],
          State: entry.running ? "running" : "exited",
          Labels: { "aceswarm.stream": entry.stream },
        })),
      ),
    inspectContainer: (id: string): Promise<ContainerDetails | undefined> => {
      const entry = engines.find((candidate) => candidate.id === id);
      return Promise.resolve(
        entry === undefined
          ? undefined
          : {
              Id: entry.id,
              Name: `/aceswarm-engine-${entry.stream}-1`,
              State: {
                Running: entry.running,
                Status: entry.running ? "running" : "exited",
                ExitCode: 0,
                StartedAt: entry.startedAt ?? NEVER,
                FinishedAt: entry.finishedAt,
                OOMKilled: entry.oomKilled,
              },
              Config: { Labels: { "aceswarm.stream": entry.stream }, Env: entry.env ?? null },
              NetworkSettings: { Networks: {} },
            },
      );
    },
    memoryUsage: (id: string): Promise<MemoryUsage | undefined> =>
      Promise.resolve(engines.find((candidate) => candidate.id === id)?.memory),
  };
  return fake as unknown as DockerClient;
}

/** The fake clock's time: an hour after the engines in these tests started. */
const clock = { now: Date.parse("2026-11-07T11:00:00Z") };

function setup(engines: FakeEngine[]): { monitor: EngineResourceMonitor; kills: string[] } {
  const kills: string[] = [];
  const monitor = new EngineResourceMonitor(
    fakeDocker(engines),
    {
      stack: "test",
      onOomKill: (stream) => {
        kills.push(stream);
      },
      now: () => clock.now,
    },
    createLogger("test", "silent"),
  );
  return { monitor, kills };
}

describe("EngineResourceMonitor", () => {
  it("reports the memory and estimated cache of running engines only", async () => {
    const stopped = { ...engine("c", "s3", 10), running: false };
    const capped = { ...engine("a", "s1", 300), env: ["PATH=/bin", `ACESWARM_MEMORY_CACHE_BYTES=${String(128 * MB)}`] };
    const { monitor } = setup([capped, engine("b", "s2", 500), stopped]);

    await monitor.sample();

    expect(monitor.latest()).toEqual([
      {
        stream: "s1",
        engine: "aceswarm-engine-s1-1",
        usedBytes: 300 * MB,
        limitBytes: 768 * MB,
        cacheLimitBytes: 128 * MB,
        cacheBytes: 128 * MB,
      },
      {
        stream: "s2",
        engine: "aceswarm-engine-s2-1",
        usedBytes: 500 * MB,
        limitBytes: 768 * MB,
        cacheLimitBytes: null,
        cacheBytes: 500 * MB - IDLE_ENGINE_MEMORY_BYTES,
      },
    ]);
  });

  it("reads the cache cap from the engine's environment", () => {
    expect(engineCacheLimit(["A=1", "ACESWARM_MEMORY_CACHE_BYTES=134217728"])).toBe(134_217_728);
    // The container's own value comes after the image's.
    expect(engineCacheLimit(["ACESWARM_MEMORY_CACHE_BYTES=536870912", "ACESWARM_MEMORY_CACHE_BYTES=134217728"])).toBe(
      134_217_728,
    );
    for (const env of [["ACESWARM_MEMORY_CACHE_BYTES=0"], ["ACESWARM_MEMORY_CACHE_BYTES=12x"], ["OTHER=1"], [], null]) {
      expect(engineCacheLimit(env)).toBeNull();
    }
  });

  it("estimates the cache as the memory above an idle engine's, at most the cap", () => {
    const idle = IDLE_ENGINE_MEMORY_BYTES;
    expect(estimateCacheBytes(100 * MB, 100 * MB, 128 * MB)).toBe(0);
    expect(estimateCacheBytes(idle + 40 * MB, idle + 40 * MB, 128 * MB)).toBe(40 * MB);
    expect(estimateCacheBytes(idle + 140 * MB, idle, 128 * MB)).toBe(128 * MB);
    expect(estimateCacheBytes(idle + 900 * MB, idle, null)).toBe(900 * MB);
    // An engine that idled lower than that counts from its own lowest reading.
    expect(estimateCacheBytes(180 * MB, 100 * MB, 128 * MB)).toBe(80 * MB);
  });

  it("counts from each engine's lowest reading since it started", async () => {
    const fresh = { ...engine("a", "s1", 100), startedAt: "2026-11-07T10:00:00Z" };
    const { monitor } = setup([fresh]);
    await monitor.sample();
    expect(monitor.latest()[0]?.cacheBytes).toBe(0);

    fresh.memory = { usedBytes: 180 * MB, limitBytes: 768 * MB };
    await monitor.sample();
    expect(monitor.latest()[0]?.cacheBytes).toBe(80 * MB);

    // After a restart the engine starts over, and a first reading above the idle memory counts from that.
    fresh.startedAt = "2026-11-07T10:30:00Z";
    fresh.memory = { usedBytes: IDLE_ENGINE_MEMORY_BYTES + 60 * MB, limitBytes: 768 * MB };
    await monitor.sample();
    expect(monitor.latest()[0]?.cacheBytes).toBe(60 * MB);
  });

  it("leaves out readings taken while an engine is still loading", async () => {
    const starting = { ...engine("a", "s1", 20), startedAt: new Date(clock.now - 1000).toISOString() };
    const { monitor } = setup([starting]);
    await monitor.sample();
    expect(monitor.latest()[0]?.cacheBytes).toBe(0);

    clock.now += ENGINE_LOADING_MS;
    starting.memory = { usedBytes: 120 * MB, limitBytes: 768 * MB };
    await monitor.sample();
    clock.now += 60_000;
    starting.memory = { usedBytes: 170 * MB, limitBytes: 768 * MB };
    await monitor.sample();
    // Counted from 120 MiB, not from the 20 MiB it used while loading.
    expect(monitor.latest()[0]?.cacheBytes).toBe(50 * MB);
  });

  it("counts each out-of-memory kill once, after the runtime restarted the engine", async () => {
    const victim = engine("a", "s1", 760);
    const { monitor, kills } = setup([victim, engine("b", "s2", 100)]);
    await monitor.sample();

    victim.finishedAt = "2026-01-01T10:00:00Z";
    victim.oomKilled = true;
    await monitor.sample();
    await monitor.sample();

    expect(kills).toEqual(["s1"]);
  });

  it("ignores an earlier kill it did not see happen and exits for other reasons", async () => {
    const old = { ...engine("a", "s1", 100), finishedAt: "2026-01-01T09:00:00Z", oomKilled: true };
    const killed = engine("b", "s2", 100);
    const { monitor, kills } = setup([old, killed]);
    await monitor.sample();

    killed.finishedAt = "2026-01-01T10:00:00Z";
    await monitor.sample();

    expect(kills).toEqual([]);
  });
});
