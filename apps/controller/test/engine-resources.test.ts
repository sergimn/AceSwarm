import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it, vi } from "vitest";
import type { ContainerDetails, ContainerSummary, DockerClient, MemoryUsage } from "../src/docker.ts";
import {
  engineCacheLimit,
  engineCacheOnDisk,
  ENGINE_LOADING_MS,
  EngineResourceMonitor,
  estimateCacheBytes,
  IDLE_ENGINE_MEMORY_BYTES,
} from "../src/engine-resources.ts";

interface FakeEngine {
  id: string;
  stream: string;
  /** Set for a path's shared engine, which has no stream label. */
  sharedPath?: string;
  /** The container state when it is neither running nor exited, such as paused. */
  state?: string;
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
          State: entry.state ?? (entry.running ? "running" : "exited"),
          Labels:
            entry.sharedPath === undefined
              ? { "aceswarm.stream": entry.stream }
              : { "aceswarm.shared-path": entry.sharedPath },
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

/**
 * A monitor over fake engines. `ended` are the runs it told, as "<container> <reason> <start> to
 * <end>", and `kept` the containers it said there are, per sample.
 */
function setup(engines: FakeEngine[]) {
  const kills: string[] = [];
  const ended: string[] = [];
  const kept: string[][] = [];
  const monitor = new EngineResourceMonitor(
    fakeDocker(engines),
    {
      stack: "test",
      onOomKill: (stream) => {
        kills.push(stream);
      },
      runs: {
        end: (run, reason) => {
          const until = new Date(run.endedAt).toISOString();
          ended.push(
            `${run.containerId} ${run.stream}|${run.sharedPath ?? "-"} ${reason} ${run.startedAt} to ${until}`,
          );
        },
        keep: (ids) => {
          kept.push([...ids]);
        },
      },
      now: () => clock.now,
    },
    createLogger("test", "silent"),
  );
  return { monitor, kills, ended, kept };
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
        sharedPath: null,
        usedBytes: 300 * MB,
        limitBytes: 768 * MB,
        cacheLimitBytes: 128 * MB,
        cacheBytes: 128 * MB,
      },
      {
        stream: "s2",
        engine: "aceswarm-engine-s2-1",
        sharedPath: null,
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

  it("reports no memory cache for an engine that keeps its cache on disk", async () => {
    const env = [
      "ACESWARM_DISK_CACHE_BYTES=0",
      `ACESWARM_MEMORY_CACHE_BYTES=${String(128 * MB)}`,
      `ACESWARM_DISK_CACHE_BYTES=${String(256 * MB)}`,
    ];
    expect(engineCacheOnDisk(env)).toBe(true);
    // The image's own value is 0, and so is the controller's without ENGINE_CACHE_DIR.
    for (const other of [["ACESWARM_DISK_CACHE_BYTES=0"], ["ACESWARM_DISK_CACHE_BYTES=x"], ["OTHER=1"], [], null]) {
      expect(engineCacheOnDisk(other)).toBe(false);
    }

    // Well above an idle engine's memory: with a memory cache that would read as a full cache.
    const { monitor } = setup([{ ...engine("a", "s1", 400), env }]);
    await monitor.sample();

    expect(monitor.latest()).toEqual([
      {
        stream: "s1",
        engine: "aceswarm-engine-s1-1",
        sharedPath: null,
        usedBytes: 400 * MB,
        limitBytes: 768 * MB,
        cacheLimitBytes: null,
        cacheBytes: 0,
      },
    ]);
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

  it("tells the run of an engine that exited and was started again, by what ended it", async () => {
    const killed = { ...engine("a", "s1", 760), startedAt: "2026-11-07T10:00:00Z" };
    const crashed = { ...engine("b", "", 100), sharedPath: "wg:vpn", startedAt: "2026-11-07T10:30:00Z" };
    const { monitor, ended } = setup([
      killed,
      crashed,
      { ...engine("c", "s3", 100), startedAt: "2026-11-07T10:00:00Z" },
    ]);
    await monitor.sample();
    expect(ended).toEqual([]);

    // The runtime started both again by the next sample.
    Object.assign(killed, { finishedAt: "2026-11-07T10:40:00Z", startedAt: "2026-11-07T10:40:01Z", oomKilled: true });
    Object.assign(crashed, { finishedAt: "2026-11-07T10:45:00Z", startedAt: "2026-11-07T10:45:02Z" });
    await monitor.sample();
    await monitor.sample();

    // Each once, from the start the sample before saw until the exit.
    expect(ended).toEqual([
      "a s1|- oom-killed 2026-11-07T10:00:00Z to 2026-11-07T10:40:00.000Z",
      "b |wg:vpn exited 2026-11-07T10:30:00Z to 2026-11-07T10:45:00.000Z",
    ]);
  });

  it("tells the run of an engine that exited and stays stopped from the start the container still says", async () => {
    const stopped = { ...engine("a", "s1", 100), startedAt: "2026-11-07T10:00:00Z" };
    const { monitor, ended } = setup([stopped]);
    await monitor.sample();

    Object.assign(stopped, { running: false, finishedAt: "2026-11-07T10:50:00Z" });
    await monitor.sample();
    await monitor.sample();

    expect(ended).toEqual(["a s1|- exited 2026-11-07T10:00:00Z to 2026-11-07T10:50:00.000Z"]);
  });

  it("tells both runs of an engine that started again and exited again between two samples", async () => {
    const stopped = { ...engine("a", "s1", 760), startedAt: "2026-11-07T10:00:00Z" };
    const { monitor, ended, kills } = setup([stopped]);
    await monitor.sample();

    // The run the last sample saw ended, nobody saw how, and the next one was killed and is not up yet.
    Object.assign(stopped, {
      running: false,
      startedAt: "2026-11-07T10:20:00Z",
      finishedAt: "2026-11-07T10:50:00Z",
      oomKilled: true,
    });
    await monitor.sample();

    // The first until the second started, which is the latest it can have ended.
    expect(ended).toEqual([
      "a s1|- exited 2026-11-07T10:00:00Z to 2026-11-07T10:20:00.000Z",
      "a s1|- oom-killed 2026-11-07T10:20:00Z to 2026-11-07T10:50:00.000Z",
    ]);
    expect(kills).toEqual(["s1"]);
  });

  it("tells no run that began before the container ever started", async () => {
    // First seen between its creation and its start.
    const created = { ...engine("a", "s1", 100), running: false, state: "created" };
    const stopped = { ...engine("b", "s2", 100), running: false, state: "created" };
    const { monitor, ended } = setup([created, stopped]);
    await monitor.sample();

    // One started, exited and runs again by the next sample; the other started and exited.
    Object.assign(created, { running: true, startedAt: "2026-11-07T10:58:30Z", finishedAt: "2026-11-07T10:58:20Z" });
    Object.assign(stopped, { state: "exited", startedAt: "2026-11-07T10:58:00Z", finishedAt: "2026-11-07T10:58:20Z" });
    await monitor.sample();

    // Only the run whose start the container says.
    expect(ended).toEqual(["b s2|- exited 2026-11-07T10:58:00Z to 2026-11-07T10:58:20.000Z"]);
  });

  it("tells no run for an exit from before its first look, or one whose start it cannot tell", async () => {
    const old = { ...engine("a", "s1", 100), startedAt: "2026-11-07T10:00:00Z", finishedAt: "2026-11-07T09:00:00Z" };
    // Its clock says it started after it exited, both at the sample before and now.
    const odd = { ...engine("b", "s2", 100), startedAt: "2026-11-07T10:55:00Z" };
    const { monitor, ended } = setup([old, odd]);
    await monitor.sample();

    Object.assign(odd, { finishedAt: "2026-11-07T10:50:00Z", startedAt: "2026-11-07T10:56:00Z" });
    await monitor.sample();

    expect(ended).toEqual([]);
  });

  it("says which engine containers there are after every sample, so the runs of the others are forgotten", async () => {
    const engines = [engine("a", "s1", 100), { ...engine("b", "s2", 100), running: false }];
    const { monitor, kept } = setup(engines);

    await monitor.sample();
    engines.pop();
    await monitor.sample();

    expect(kept).toEqual([["a", "b"], ["a"]]);
  });

  it("counts the running engines, own and shared, from the last sample", async () => {
    const shared = { ...engine("d", "", 200), sharedPath: "wg:vpn" };
    const restarting = { ...engine("e", "", 0), sharedPath: "direct", state: "restarting" };
    const paused = { ...engine("f", "s4", 100), state: "paused" };
    const stopped = { ...engine("c", "s3", 10), running: false };
    const engines = [engine("a", "s1", 300), engine("b", "s1", 200), shared, restarting, paused, stopped];
    const { monitor } = setup(engines);
    expect(monitor.running()).toBeUndefined();

    await monitor.sample();
    expect(monitor.running()).toEqual({ own: 2, shared: 1 });
    // A shared engine says which path it is of; an engine of a stream has none.
    expect(monitor.latest().map(({ stream, sharedPath }) => [stream, sharedPath])).toEqual([
      ["s1", null],
      ["s1", null],
      ["", "wg:vpn"],
    ]);

    engines.splice(0, 3);
    await monitor.sample();
    expect(monitor.running()).toEqual({ own: 0, shared: 0 });
  });

  it("drops the count when it can't list the engines, rather than keep an old one", async () => {
    const docker = fakeDocker([engine("a", "s1", 300)]);
    const monitor = new EngineResourceMonitor(
      docker,
      { stack: "test", onOomKill: () => undefined },
      createLogger("test", "silent"),
    );
    await monitor.sample();
    expect(monitor.running()).toEqual({ own: 1, shared: 0 });

    vi.spyOn(docker, "listContainers").mockRejectedValueOnce(new Error("socket proxy down"));
    await expect(monitor.sample()).rejects.toThrow("socket proxy down");
    expect(monitor.running()).toBeUndefined();

    await monitor.sample();
    expect(monitor.running()).toEqual({ own: 1, shared: 0 });
  });
});
