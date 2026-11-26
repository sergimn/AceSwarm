import type { StreamView } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import { createLogger } from "@aceswarm/shared/logger";
import { expect, test } from "vitest";
import type { AcestreamClient } from "../src/acestream.ts";
import type { ContainerDetails, ContainerSummary, DockerClient, MemoryUsage } from "../src/docker.ts";
import { EnginePlaces, LEFT_HOLD_MS } from "../src/engine-places.ts";
import { EngineResourceMonitor } from "../src/engine-resources.ts";
import { EngineRuns } from "../src/engine-runs.ts";
import { EngineManager, type EngineHandle } from "../src/engines.ts";

// The parts that see an engine's run end, wired as in main.ts over one fake container: the engine
// manager, the resource sampler, the runs they tell and the places the log line reads.

const NAME = "aceswarm-engine-s1-1";
const ID = "c1";
const NEVER = "0001-01-01T00:00:00Z";
const USAGE: MemoryUsage = { usedBytes: 200 * 1024 * 1024, limitBytes: 512 * 1024 * 1024 };

/** The fake container's state, which a test changes as the container runtime would. */
interface Container {
  /** What the container list says: running, exited, or something in between. */
  state: string;
  startedAt: string;
  finishedAt: string;
  oomKilled: boolean;
  /** Gone from the runtime. */
  removed: boolean;
}

/** What a test makes a Docker call do: change the container, wait for the test, or fail. */
type Act = (container: Container) => Promise<void> | void;

function wired(act: { remove?: Act; restart?: Act } = {}) {
  const container: Container = {
    state: "running",
    startedAt: "2026-11-07T10:00:00Z",
    finishedAt: NEVER,
    oomKilled: false,
    removed: false,
  };
  const details = (): ContainerDetails => ({
    Id: ID,
    Name: `/${NAME}`,
    State: {
      Running: container.state === "running",
      Status: container.state,
      ExitCode: 0,
      StartedAt: container.startedAt,
      FinishedAt: container.finishedAt,
      OOMKilled: container.oomKilled,
    },
    Config: { Labels: { "aceswarm.stream": "s1" }, Env: null },
    NetworkSettings: { Networks: { engines: { IPAddress: "172.31.250.130" } } },
  });
  const docker = {
    listContainers: (): Promise<ContainerSummary[]> =>
      Promise.resolve(
        container.removed
          ? []
          : [{ Id: ID, Names: [`/${NAME}`], State: container.state, Labels: { "aceswarm.stream": "s1" } }],
      ),
    inspectContainer: (): Promise<ContainerDetails | undefined> =>
      Promise.resolve(container.removed ? undefined : details()),
    memoryUsage: (): Promise<MemoryUsage | undefined> =>
      Promise.resolve(container.state === "running" ? USAGE : undefined),
    removeContainer: async (): Promise<void> => {
      await act.remove?.(container);
      container.removed = true;
    },
    restartContainer: async (): Promise<void> => {
      await act.restart?.(container);
    },
  } as unknown as DockerClient;

  const clock = { now: Date.parse("2026-11-07T11:00:00Z") };
  const lines: Record<string, unknown>[] = [];
  const logger = {
    child: () => logger,
    info: (fields: Record<string, unknown>, msg: string) => {
      if (msg.startsWith("engine ") && "reason" in fields) {
        lines.push({ ...fields, msg });
      }
    },
    warn: () => undefined,
  } as unknown as Logger;
  const places = new EnginePlaces(
    () => [],
    () => clock.now,
  );
  const runs = new EngineRuns({ observe: () => undefined, placeOf: (engine) => places.placeOf(engine), logger });
  const ace = { version: () => Promise.resolve("3.2.11") } as unknown as AcestreamClient;
  const options = {
    stack: "aceswarm",
    image: "engine:test",
    network: "engines",
    gatewayIp: "172.31.250.2",
    httpPort: 6878,
    memoryMb: 512,
    memoryCacheMb: 128,
    cacheDir: "",
    diskCacheMb: 256,
    extraFlags: "",
    dns: "1.1.1.1",
    readyTimeoutMs: 5000,
  };
  const engines = new EngineManager(docker, ace, options, createLogger("test", "silent"), runs);
  const monitor = new EngineResourceMonitor(
    docker,
    { stack: "aceswarm", network: "engines", onOomKill: () => undefined, runs, now: () => clock.now },
    createLogger("test", "silent"),
  );
  /** A round of the engine sampler, 15 seconds after the last, as main.ts runs it. */
  const sample = async (streams: StreamView[]): Promise<void> => {
    clock.now += 15_000;
    await monitor.sample();
    places.resolve(monitor.latest(), streams);
  };
  /** What the lines say, as "<msg>: <reason> <role> <path>". */
  const told = (): string[] =>
    lines.map(
      (line) => `${String(line["msg"])}: ${String(line["reason"])} ${String(line["role"])} ${String(line["path"])}`,
    );
  const handle: EngineHandle = {
    containerId: ID,
    name: NAME,
    streamId: "s1",
    generation: 1,
    ip: "172.31.250.130",
    baseUrl: "http://172.31.250.130:6878",
    sharedPath: null,
  };
  return { container, engines, sample, told, clock, handle };
}

function stream(over: Partial<StreamView>): StreamView {
  return {
    id: "s1",
    aceId: "a".repeat(40),
    aceIdKind: "infohash",
    name: "s1",
    enabled: true,
    createdAt: "2026-11-06T10:00:00.000Z",
    state: "playing",
    stateSince: "2026-11-06T10:00:00.000Z",
    message: null,
    lastFrameAt: null,
    liveEdge: null,
    peers: { connected: null, active: null, uploading: null, countries: [] },
    downloadKBps: null,
    uploadKBps: null,
    path: "direct",
    recoveries: 0,
    viewers: 0,
    hls: { preview: "", full: "", thumbnail: "" },
    engine: null,
    standbys: [],
    ...over,
  };
}

const PLAYING = [stream({ engine: { name: NAME, shared: false } })];
const STOPPED = [stream({ state: "stopped", path: null, engine: null })];

test("a removed engine's line says what it was for, though samples without it ran before Docker answered", async () => {
  const began = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const fake = wired({
    remove: async (container) => {
      // The container is on its way out: no longer running, not gone yet.
      container.state = "removing";
      began.resolve(undefined);
      await gate.promise;
    },
  });
  await fake.sample(PLAYING);

  const removing = fake.engines.remove(fake.handle, "stopped");
  await began.promise;
  // The removal takes long; the sampler runs meanwhile and no longer finds the engine running.
  await fake.sample(STOPPED);
  fake.clock.now += LEFT_HOLD_MS;
  await fake.sample(STOPPED);
  gate.resolve(undefined);
  await removing;

  expect(fake.told()).toEqual(["engine removed: stopped playing direct"]);
  // And the sampler has nothing to add once the container is gone.
  await fake.sample(STOPPED);
  expect(fake.told()).toHaveLength(1);
});

test("an engine restarted from outside is told with its place, though a sample found it stopping", async () => {
  const fake = wired();
  await fake.sample(PLAYING);

  // Stopping takes a while: not running any more, and its exit does not show yet.
  fake.container.state = "stopping";
  await fake.sample(PLAYING);
  expect(fake.told()).toEqual([]);

  Object.assign(fake.container, {
    state: "running",
    finishedAt: "2026-11-07T11:00:35Z",
    startedAt: "2026-11-07T11:00:36Z",
  });
  await fake.sample(PLAYING);
  await fake.sample(PLAYING);

  expect(fake.told()).toEqual(["engine exited: exited playing direct"]);
});

test("a restart by the controller right after a kill counts both runs once", async () => {
  const began = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const fake = wired({
    restart: async (container) => {
      // Stopping the engine takes a moment, in which the sampler looks.
      began.resolve(undefined);
      await gate.promise;
      Object.assign(container, { finishedAt: "2026-11-07T11:00:25Z", startedAt: "2026-11-07T11:00:26Z" });
      container.oomKilled = false;
    },
  });
  await fake.sample(PLAYING);

  // The kernel kills the engine and the runtime starts it again, between two samples.
  Object.assign(fake.container, {
    finishedAt: "2026-11-07T11:00:20Z",
    startedAt: "2026-11-07T11:00:21Z",
    oomKilled: true,
  });
  const restarting = fake.engines.restart(fake.handle, undefined, "manual restart");
  await began.promise;
  await fake.sample(PLAYING);
  gate.resolve(undefined);
  await restarting;
  await fake.sample(PLAYING);
  await fake.sample(PLAYING);

  expect(fake.told()).toEqual(["engine exited: oom-killed playing direct", "engine restarted: restart playing direct"]);
});

test("a restart that stops the engine and cannot start it again counts the exit the sampler saw", async () => {
  const began = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const fake = wired({
    restart: async (container) => {
      Object.assign(container, { state: "exited", finishedAt: "2026-11-07T11:00:20Z" });
      began.resolve(undefined);
      await gate.promise;
      throw new Error("docker said no");
    },
  });
  await fake.sample(PLAYING);

  const restarting = fake.engines.restart(fake.handle, undefined, "manual restart");
  await began.promise;
  await fake.sample(PLAYING);
  // Nothing yet: the controller may still tell this run with its own reason.
  expect(fake.told()).toEqual([]);
  gate.resolve(undefined);
  await expect(restarting).rejects.toThrow("docker said no");

  expect(fake.told()).toEqual(["engine exited: exited playing direct"]);
  await fake.sample(PLAYING);
  expect(fake.told()).toHaveLength(1);
});
