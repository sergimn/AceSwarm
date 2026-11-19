import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { AcestreamClient } from "../src/acestream.ts";
import type { ContainerDetails, ContainerSpec, DockerClient } from "../src/docker.ts";
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
