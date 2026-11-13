import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import { loadCleanupConfig } from "../src/config.ts";
import type { ContainerSummary, DockerClient } from "../src/docker.ts";
import { CONTROLLER_LABEL, removeEnginesOnStackDown } from "../src/stack-cleanup.ts";

const logger = createLogger("test", "silent");

interface FakeContainer {
  id: string;
  state: string;
  labels: Record<string, string>;
  /** Removing it fails. */
  stuck?: boolean;
}

function engine(id: string, labels: Record<string, string>, state = "running"): FakeContainer {
  return { id, state, labels: { "aceswarm.stack": "aceswarm", "aceswarm.role": "engine", ...labels } };
}

function controller(state: string, stack = "aceswarm"): FakeContainer {
  return { id: `controller-${state}-${stack}`, state, labels: { [CONTROLLER_LABEL]: stack } };
}

/** Lists containers by their labels, as the Docker API filters them, and records removals. */
function fakeDocker(containers: FakeContainer[]): { docker: DockerClient; removed: string[] } {
  const removed: string[] = [];
  const fake = {
    listContainers: (labels: Record<string, string>): Promise<ContainerSummary[]> =>
      Promise.resolve(
        containers
          .filter((container) => !removed.includes(container.id))
          .filter((container) => Object.entries(labels).every(([key, value]) => container.labels[key] === value))
          .map((container) => ({
            Id: container.id,
            Names: [`/${container.id}`],
            State: container.state,
            Labels: container.labels,
          })),
      ),
    removeContainer: (id: string): Promise<void> => {
      if (containers.find((container) => container.id === id)?.stuck === true) {
        return Promise.reject(new Error("docker DELETE returned 500"));
      }
      removed.push(id);
      return Promise.resolve();
    },
  };
  return { docker: fake as unknown as DockerClient, removed };
}

const engines = (): FakeContainer[] => [
  engine("own", { "aceswarm.stream": "a" }),
  engine("standby", { "aceswarm.stream": "a" }),
  engine("shared", { "aceswarm.shared-path": "direct" }),
  engine("exited", { "aceswarm.stream": "b" }, "exited"),
];

describe("removing the engines when the stack goes down", () => {
  it("removes every engine of the stack once no controller runs: own, standby, shared and stopped ones", async () => {
    const { docker, removed } = fakeDocker([
      ...engines(),
      controller("exited"),
      engine("other-stack", { "aceswarm.stack": "other", "aceswarm.stream": "c" }),
      { id: "transcoder", state: "running", labels: {} },
    ]);

    const result = await removeEnginesOnStackDown(docker, "aceswarm", logger);

    expect(result).toEqual({ outcome: "removed", removed: 4, failed: 0 });
    expect(removed.toSorted((a, b) => a.localeCompare(b, "en"))).toEqual(["exited", "own", "shared", "standby"]);
  });

  it("removes them when there is no controller container at all", async () => {
    const { docker, removed } = fakeDocker(engines());
    expect(await removeEnginesOnStackDown(docker, "aceswarm", logger)).toMatchObject({ removed: 4 });
    expect(removed).toHaveLength(4);
  });

  it.each(["running", "restarting", "paused", "stopping"])(
    "leaves every engine while a controller is %s: only the cleanup service is going away",
    async (state) => {
      const { docker, removed } = fakeDocker([...engines(), controller("exited"), controller(state)]);

      const result = await removeEnginesOnStackDown(docker, "aceswarm", logger);

      expect(result).toEqual({ outcome: "kept", controllers: [`controller-${state}-aceswarm`] });
      expect(removed).toEqual([]);
    },
  );

  it("ignores a running controller of another stack", async () => {
    const { docker, removed } = fakeDocker([...engines(), controller("running", "other")]);
    expect(await removeEnginesOnStackDown(docker, "aceswarm", logger)).toMatchObject({ outcome: "removed" });
    expect(removed).toHaveLength(4);
  });

  it("goes on removing the others when one engine can't be removed", async () => {
    const { docker, removed } = fakeDocker([
      ...engines(),
      { ...engine("stuck", { "aceswarm.stream": "d" }), stuck: true },
    ]);

    const result = await removeEnginesOnStackDown(docker, "aceswarm", logger);

    expect(result).toEqual({ outcome: "removed", removed: 4, failed: 1 });
    expect(removed.toSorted((a, b) => a.localeCompare(b, "en"))).toEqual(["exited", "own", "shared", "standby"]);
  });

  it("reads the same Docker endpoint and stack name settings as the controller", () => {
    expect(loadCleanupConfig({})).toEqual({ DOCKER_HOST: "http://docker-proxy:2375", STACK_NAME: "aceswarm" });
    expect(loadCleanupConfig({ DOCKER_HOST: "tcp://proxy:2375/", STACK_NAME: "aceswarm-e2e" })).toEqual({
      DOCKER_HOST: "http://proxy:2375",
      STACK_NAME: "aceswarm-e2e",
    });
    expect(() => loadCleanupConfig({ STACK_NAME: "Not A Stack" })).toThrow();
  });
});
