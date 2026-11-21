import type { Logger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { ContainerDetails } from "../src/docker.ts";
import type { EnginePlace } from "../src/engine-places.ts";
import { ENGINE_END_REASONS, engineRun, EngineRuns, type EngineRun } from "../src/engine-runs.ts";

const NEVER = "0001-01-01T00:00:00Z";
const STARTED = "2026-11-07T10:00:00.123456789Z";
const NOW = Date.parse("2026-11-07T11:00:00Z");

function container(state: Partial<ContainerDetails["State"]>, labels: Record<string, string>): ContainerDetails {
  return {
    Id: "c1",
    Name: "/aceswarm-engine-s1-4",
    State: {
      Running: true,
      Status: "running",
      ExitCode: 0,
      StartedAt: STARTED,
      FinishedAt: NEVER,
      OOMKilled: false,
      ...state,
    },
    Config: { Labels: labels },
    NetworkSettings: { Networks: {} },
  };
}

/** A run of a stream's own engine that lasted an hour. */
const run: EngineRun = {
  containerId: "c1",
  engine: "aceswarm-engine-s1-4",
  stream: "s1",
  sharedPath: null,
  startedAt: STARTED,
  endedAt: NOW,
};

/** Engine runs whose count and log lines the test reads. */
function setup(places: Record<string, EnginePlace> = {}) {
  const observed: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const logger = {
    child: () => logger,
    info: (fields: Record<string, unknown>, msg: string) => {
      lines.push({ ...fields, msg });
    },
  } as unknown as Logger;
  const runs = new EngineRuns({
    observe: (kind, reason, seconds) => {
      observed.push(`${kind} ${reason} ${String(seconds)}`);
    },
    placeOf: (engine) => places[engine],
    logger,
  });
  return { runs, observed, lines };
}

describe("engineRun", () => {
  it("lasts until now while the engine runs", () => {
    expect(engineRun(container({}, { "aceswarm.stream": "s1" }), NOW)).toEqual(run);
  });

  it("lasts until the engine exited once it did", () => {
    const exited = container(
      { Running: false, Status: "exited", FinishedAt: "2026-11-07T10:20:00Z" },
      { "aceswarm.stream": "s1" },
    );

    expect(engineRun(exited, NOW)).toEqual({ ...run, endedAt: Date.parse("2026-11-07T10:20:00Z") });
  });

  it("goes by now when the last exit is from the run before", () => {
    // The runtime is starting it again: it says the new start, and still the last exit.
    const restarting = container(
      { Running: false, Status: "restarting", FinishedAt: "2026-11-07T09:59:00Z" },
      { "aceswarm.stream": "s1" },
    );

    expect(engineRun(restarting, NOW)?.endedAt).toBe(NOW);
  });

  it("is a shared engine's by its path label", () => {
    const shared = { ...container({}, { "aceswarm.shared-path": "wg:a" }), Name: "/aceswarm-engine-shared-wg-a-2" };

    expect(engineRun(shared, NOW)).toMatchObject({
      engine: "aceswarm-engine-shared-wg-a-2",
      stream: "",
      sharedPath: "wg:a",
    });
  });

  it("has none for a container that never started", () => {
    expect(engineRun(container({ Running: false, Status: "created", StartedAt: NEVER }, {}), NOW)).toBeUndefined();
  });
});

describe("EngineRuns", () => {
  it("counts a removed engine's run by its reason, and logs what the engine was for", () => {
    const { runs, observed, lines } = setup({ "aceswarm-engine-s1-4": { role: "playing", path: "direct" } });

    runs.end(run, "moved");

    expect(observed).toEqual(["own moved 3600"]);
    expect(lines).toEqual([
      {
        engine: "aceswarm-engine-s1-4",
        stream: "s1",
        kind: "own",
        role: "playing",
        path: "direct",
        reason: "moved",
        lifetimeSeconds: 3600,
        msg: "engine removed",
      },
    ]);
  });

  it("logs a restart and an exit as such, with what the caller says more about it", () => {
    const { runs, observed, lines } = setup({ "aceswarm-engine-s1-4": { role: "playing", path: "wg:a" } });

    runs.end(run, "restart", "manual restart");
    runs.end({ ...run, containerId: "c2" }, "oom-killed");
    runs.end({ ...run, containerId: "c3" }, "exited");

    expect(observed).toEqual(["own restart 3600", "own oom-killed 3600", "own exited 3600"]);
    expect(lines.map((line) => line["msg"])).toEqual(["engine restarted", "engine exited", "engine exited"]);
    expect(lines[0]).toMatchObject({ reason: "restart", detail: "manual restart", path: "wg:a" });
    expect(lines[1]).not.toHaveProperty("detail");
  });

  it("says a shared engine's path from its container, and leaves the place of an unknown engine empty", () => {
    const { runs, observed, lines } = setup();

    runs.end({ ...run, engine: "aceswarm-engine-shared-wg-a-2", stream: "", sharedPath: "wg:a" }, "idle");
    runs.end({ ...run, containerId: "c2", engine: "aceswarm-engine-s1-9" }, "leftover");

    expect(observed).toEqual(["shared idle 3600", "own leftover 3600"]);
    expect(lines[0]).toMatchObject({ kind: "shared", role: "shared", path: "wg:a", stream: "" });
    expect(lines[1]).toMatchObject({ kind: "own", role: "", path: "" });
  });

  it("counts a run once, and the container's next run again", () => {
    const { runs, observed } = setup();

    runs.end(run, "restart");
    // The sampler sees the same container exit.
    runs.end({ ...run, endedAt: NOW + 2000 }, "exited");
    runs.end({ ...run, startedAt: "2026-11-07T11:00:05Z", endedAt: NOW + 65_000 }, "moved");

    expect(observed).toEqual(["own restart 3600", "own moved 60"]);
  });

  it("keeps a run the controller is ending for the controller's reason", () => {
    const { runs, observed, lines } = setup();

    const ended = runs.ending(run);
    // The sampler looks while the container restarts.
    runs.end(run, "exited");
    expect(observed).toEqual([]);

    ended("restart", "no video after 61s");
    expect(observed).toEqual(["own restart 3600"]);
    expect(lines).toHaveLength(1);
  });

  it("lets a run be told later when the controller could not end it", () => {
    const { runs, observed } = setup();

    runs.ending(run)();
    expect(observed).toEqual([]);

    runs.end({ ...run, endedAt: NOW + 60_000 }, "oom-killed");
    expect(observed).toEqual(["own oom-killed 3660"]);
  });

  it("leaves a run that was told alone when a second ending of it fails", () => {
    const { runs, observed } = setup();
    runs.end(run, "exited");

    // The container had exited by itself; removing it then fails.
    runs.ending(run)();
    runs.end(run, "leftover");

    expect(observed).toEqual(["own exited 3600"]);
  });

  it("forgets the containers that are gone", () => {
    const { runs, observed } = setup();
    runs.end(run, "moved");
    runs.end({ ...run, containerId: "c2" }, "moved");

    runs.keep(new Set(["c2"]));
    // Only to show what was forgotten: a container that is gone has no later run.
    runs.end(run, "leftover");
    runs.end({ ...run, containerId: "c2" }, "leftover");

    expect(observed).toEqual(["own moved 3600", "own moved 3600", "own leftover 3600"]);
  });

  it("never counts a negative time", () => {
    const { runs, observed } = setup();

    runs.end({ ...run, endedAt: Date.parse(STARTED) - 5000 }, "exited");

    expect(observed).toEqual(["own exited 0"]);
  });
});

describe("ENGINE_END_REASONS", () => {
  it("lists the reasons of each kind of engine: only a stream's own engine restarts in place", () => {
    expect(ENGINE_END_REASONS.own).toEqual([
      "moved",
      "move-failed",
      "standby-removed",
      "sharing",
      "stopped",
      "leftover",
      "restart",
      "oom-killed",
      "exited",
    ]);
    expect(ENGINE_END_REASONS.shared).toEqual(["replaced", "idle", "unresponsive", "leftover", "oom-killed", "exited"]);
  });
});
