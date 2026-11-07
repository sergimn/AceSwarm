import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it, vi } from "vitest";
import type { ContainerDetails, ContainerSummary, DockerClient, MemoryUsage } from "../src/docker.ts";
import { EngineResourceMonitor } from "../src/engine-resources.ts";

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
}

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
                StartedAt: NEVER,
                FinishedAt: entry.finishedAt,
                OOMKilled: entry.oomKilled,
              },
              Config: { Labels: { "aceswarm.stream": entry.stream } },
              NetworkSettings: { Networks: {} },
            },
      );
    },
    memoryUsage: (id: string): Promise<MemoryUsage | undefined> =>
      Promise.resolve(engines.find((candidate) => candidate.id === id)?.memory),
  };
  return fake as unknown as DockerClient;
}

function setup(engines: FakeEngine[]): { monitor: EngineResourceMonitor; kills: string[] } {
  const kills: string[] = [];
  const monitor = new EngineResourceMonitor(
    fakeDocker(engines),
    {
      stack: "test",
      onOomKill: (stream) => {
        kills.push(stream);
      },
    },
    createLogger("test", "silent"),
  );
  return { monitor, kills };
}

describe("EngineResourceMonitor", () => {
  it("reports the memory of running engines only", async () => {
    const stopped = { ...engine("c", "s3", 10), running: false };
    const { monitor } = setup([engine("a", "s1", 300), engine("b", "s2", 500), stopped]);

    await monitor.sample();

    expect(monitor.latest()).toEqual([
      { stream: "s1", engine: "aceswarm-engine-s1-1", usedBytes: 300 * 1024 * 1024, limitBytes: 768 * 1024 * 1024 },
      { stream: "s2", engine: "aceswarm-engine-s2-1", usedBytes: 500 * 1024 * 1024, limitBytes: 768 * 1024 * 1024 },
    ]);
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
