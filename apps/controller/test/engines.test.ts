import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { AcestreamClient } from "../src/acestream.ts";
import type { ContainerDetails, ContainerSpec, DockerClient } from "../src/docker.ts";
import type { EngineEndReason, EngineRun, EngineRuns } from "../src/engine-runs.ts";
import { EngineGoneError, EngineManager, type EngineManagerOptions } from "../src/engines.ts";

const OPTIONS: EngineManagerOptions = {
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

/** What the container runtime reports about the engine once it was started. */
type State = Pick<ContainerDetails["State"], "Running" | "Status" | "ExitCode">;

const RUNNING: State = { Running: true, Status: "running", ExitCode: 0 };

function setup(options: Partial<EngineManagerOptions>, state: State = RUNNING) {
  const created: { name: string; spec: ContainerSpec }[] = [];
  const docker = {
    inspectContainer: (id: string): Promise<ContainerDetails | undefined> => {
      const container = created.find((entry) => entry.name === id);
      if (container === undefined) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({
        Id: id,
        Name: `/${id}`,
        State: { ...state, StartedAt: "", FinishedAt: "", OOMKilled: false },
        Config: { Labels: container.spec.Labels, Env: container.spec.Env },
        NetworkSettings: { Networks: { engines: { IPAddress: "172.31.250.130" } } },
      });
    },
    createContainer: (name: string, spec: ContainerSpec): Promise<string> => {
      created.push({ name, spec });
      return Promise.resolve(name);
    },
    startContainer: (): Promise<void> => Promise.resolve(),
  } as unknown as DockerClient;
  const ace = { version: () => Promise.resolve("3.2.11") } as unknown as AcestreamClient;
  const engines = new EngineManager(docker, ace, { ...OPTIONS, ...options }, createLogger("test", "silent"));
  return { engines, created };
}

describe("EngineManager", () => {
  it("starts an engine with its cache in memory and no host folder by default", async () => {
    const { engines, created } = setup({});

    const handle = await engines.create("s1", 1);

    expect(handle).toMatchObject({ name: "aceswarm-engine-s1-1", streamId: "s1", generation: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]?.spec.HostConfig["Mounts"]).toEqual([]);
    expect(created[0]?.spec.HostConfig).not.toHaveProperty("Binds");
    expect(created[0]?.spec.Env).toContain("ACESWARM_DISK_CACHE_BYTES=0");
  });

  it("mounts the cache folder into every engine it starts when one is set, a path's shared engine too", async () => {
    const { engines, created } = setup({ cacheDir: "/mnt/ssd/cache", diskCacheMb: 300 });

    await engines.create("s1", 1);
    await engines.createShared("direct", 2);

    expect(created.map((entry) => entry.name)).toEqual(["aceswarm-engine-s1-1", "aceswarm-engine-shared-direct-2"]);
    for (const { spec } of created) {
      // A bind mount given as a mount fails when the folder is missing; as a "bind" the runtime
      // would make it, on whatever disk is there.
      expect(spec.HostConfig["Mounts"]).toEqual([{ Type: "bind", Source: "/mnt/ssd/cache", Target: "/cache" }]);
      expect(spec.HostConfig).not.toHaveProperty("Binds");
      expect(spec.Env).toContain(`ACESWARM_DISK_CACHE_BYTES=${String(300 * 1024 * 1024)}`);
      // The engine keeps its memory limit.
      expect(spec.HostConfig["Memory"]).toBe(512 * 1024 * 1024);
    }
  });

  it.each([
    ["restarting", { Running: true, Status: "restarting", ExitCode: 78 }],
    ["exited", { Running: false, Status: "exited", ExitCode: 78 }],
  ])("says what to check when the engine cannot set up its cache folder (%s)", async (_name, state) => {
    const { engines } = setup({ cacheDir: "/mnt/ssd/cache" }, state);

    const start = engines.create("s1", 1);

    await expect(start).rejects.toBeInstanceOf(EngineGoneError);
    await expect(start).rejects.toThrow(
      /could not set up its cache on disk: the container runtime has to be able to write to the folder ENGINE_CACHE_DIR names/,
    );
  });

  it("reports any other exit by its code", async () => {
    const { engines } = setup({}, { Running: false, Status: "exited", ExitCode: 1 });

    await expect(engines.create("s1", 1)).rejects.toThrow("engine exited with code 1");
  });
});

/**
 * An engine manager that tells the runs it ends, over one container of stream s1 that started at
 * ten and runs. `calls` are the Docker requests and what was told, in order.
 */
function withRuns(fails: { inspect?: boolean; remove?: boolean; restart?: boolean } = {}) {
  const calls: string[] = [];
  const containers = new Map<string, ContainerDetails>();
  const add = (name: string, startedAt: string): void => {
    containers.set(name, {
      Id: `id-${name}`,
      Name: `/${name}`,
      State: { ...RUNNING, StartedAt: startedAt, FinishedAt: "0001-01-01T00:00:00Z", OOMKilled: false },
      Config: { Labels: { "aceswarm.stream": "s1" } },
      NetworkSettings: { Networks: { engines: { IPAddress: "172.31.250.130" } } },
    });
  };
  add("aceswarm-engine-s1-1", "2026-11-07T10:00:00Z");
  const find = (idOrName: string): ContainerDetails | undefined =>
    containers.values().find((details) => details.Id === idOrName || details.Name === `/${idOrName}`);
  const answer = async (call: string, fail: boolean | undefined): Promise<void> => {
    calls.push(call);
    await Promise.resolve();
    if (fail === true) {
      throw new Error("docker said no");
    }
  };
  const docker = {
    listContainers: () =>
      Promise.resolve(
        containers
          .values()
          .map((details) => ({
            Id: details.Id,
            Names: [details.Name],
            State: "running",
            Labels: details.Config.Labels,
          }))
          .toArray(),
      ),
    inspectContainer: async (idOrName: string): Promise<ContainerDetails | undefined> => {
      await answer(`inspect ${idOrName}`, fails.inspect);
      return find(idOrName);
    },
    removeContainer: async (id: string): Promise<void> => {
      await answer(`remove ${id}`, fails.remove);
      containers.delete(find(id)?.Name.slice(1) ?? "");
    },
    restartContainer: async (id: string): Promise<void> => {
      await answer(`restart ${id}`, fails.restart);
      const details = find(id);
      if (details !== undefined) {
        details.State = { ...details.State, StartedAt: "2026-11-07T11:00:01Z", FinishedAt: "2026-11-07T11:00:00Z" };
      }
    },
    createContainer: (name: string): Promise<string> => {
      calls.push(`create ${name}`);
      add(name, "2026-11-07T11:00:00Z");
      return Promise.resolve(`id-${name}`);
    },
    startContainer: (): Promise<void> => Promise.resolve(),
  } as unknown as DockerClient;
  const ace = { version: () => Promise.resolve("3.2.11") } as unknown as AcestreamClient;
  const runs = {
    ending: (run: EngineRun) => {
      calls.push(`ending ${run.engine} since ${run.startedAt}`);
      return (reason?: EngineEndReason, detail?: string) => {
        calls.push(`ended ${[run.engine, reason ?? "not", detail].filter((part) => part !== undefined).join(" | ")}`);
      };
    },
  } as unknown as EngineRuns;
  const engines = new EngineManager(docker, ace, OPTIONS, createLogger("test", "silent"), runs);
  const handle = { containerId: "id-aceswarm-engine-s1-1", name: "aceswarm-engine-s1-1" };
  return { engines, calls, handle };
}

describe("EngineManager, the runs it ends", () => {
  it("tells the run of an engine it removes, once it is removed, with the caller's reason", async () => {
    const { engines, calls, handle } = withRuns();

    await engines.remove(handle, "moved");

    expect(calls).toEqual([
      "inspect id-aceswarm-engine-s1-1",
      "ending aceswarm-engine-s1-1 since 2026-11-07T10:00:00Z",
      "remove id-aceswarm-engine-s1-1",
      "ended aceswarm-engine-s1-1 | moved",
    ]);
  });

  it("finds the run of a container it is given by name, and passes on what the caller says more", async () => {
    const { engines, calls } = withRuns();

    await engines.remove(
      { containerId: "aceswarm-engine-s1-1", name: "aceswarm-engine-s1-1" },
      "standby-removed",
      "hot standby is off",
    );

    expect(calls.at(-1)).toBe("ended aceswarm-engine-s1-1 | standby-removed | hot standby is off");
  });

  it("counts an engine nobody gave a reason for as a leftover", async () => {
    const { engines, calls, handle } = withRuns();

    await engines.remove(handle);

    expect(calls.at(-1)).toBe("ended aceswarm-engine-s1-1 | leftover");
  });

  it("takes the run back when the engine could not be removed", async () => {
    const { engines, calls, handle } = withRuns({ remove: true });

    await expect(engines.remove(handle, "moved")).rejects.toThrow("docker said no");

    expect(calls.at(-1)).toBe("ended aceswarm-engine-s1-1 | not");
  });

  it("removes an engine whose run it cannot read, or that is gone, without telling a run", async () => {
    const unreadable = withRuns({ inspect: true });
    await unreadable.engines.remove(unreadable.handle, "moved");
    expect(unreadable.calls).toEqual(["inspect id-aceswarm-engine-s1-1", "remove id-aceswarm-engine-s1-1"]);

    const gone = withRuns();
    await gone.engines.remove({ containerId: "id-gone", name: "gone" }, "moved");
    expect(gone.calls).toEqual(["inspect id-gone", "remove id-gone"]);
  });

  it("tells the run a restart ends as a restart, read before the engine has its new start", async () => {
    const { engines, calls, handle } = withRuns();

    await engines.restart(
      { ...handle, streamId: "s1", generation: 1, ip: "", baseUrl: "", sharedPath: null },
      undefined,
      "manual restart",
    );

    expect(calls.slice(0, 4)).toEqual([
      "inspect id-aceswarm-engine-s1-1",
      "ending aceswarm-engine-s1-1 since 2026-11-07T10:00:00Z",
      "restart id-aceswarm-engine-s1-1",
      "ended aceswarm-engine-s1-1 | restart | manual restart",
    ]);
  });

  it("tells every run that removing a stream's engines ends, with the same reason", async () => {
    const { engines, calls } = withRuns();

    await engines.removeAllFor("s1", "stopped");

    expect(calls.at(-1)).toBe("ended aceswarm-engine-s1-1 | stopped");
  });

  it("removes a container that has the name of the engine it starts as a leftover", async () => {
    const { engines, calls } = withRuns();

    await engines.create("s1", 1);

    expect(calls.slice(0, 6)).toEqual([
      "inspect aceswarm-engine-s1-1",
      "inspect id-aceswarm-engine-s1-1",
      "ending aceswarm-engine-s1-1 since 2026-11-07T10:00:00Z",
      "remove id-aceswarm-engine-s1-1",
      "ended aceswarm-engine-s1-1 | leftover | a new engine takes its name",
      "create aceswarm-engine-s1-1",
    ]);
  });

  it("removes the engines of streams that are gone as leftovers, by their name without the slash", async () => {
    const { engines, calls } = withRuns();

    expect(await engines.removeOrphans(new Set(["s2"]))).toBe(1);

    expect(calls.at(-1)).toBe("ended aceswarm-engine-s1-1 | leftover | its stream is gone or disabled");
  });
});
