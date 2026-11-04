import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { ContainerDetails, ContainerSummary, DockerClient, MemoryUsage } from "../src/docker.ts";
import { EngineResourceMonitor } from "../src/engine-resources.ts";

interface FakeEngine {
  id: string;
  stream: string;
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
});
