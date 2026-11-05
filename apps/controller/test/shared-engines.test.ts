import { setImmediate } from "node:timers/promises";
import { Registry } from "@prometheus-io/client";
import type { PathAssignment } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, test } from "vitest";
import type { NetgwClient } from "../src/clients.ts";
import { EngineGoneError, type EngineHandle, type EngineManager, type OnEngineAddress } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import { SharedEngines, type SharedEngineSettings } from "../src/shared-engines.ts";

const settings: SharedEngineSettings = {
  maxFailures: 2,
  failureWindowMs: 60_000,
  retireTimeoutMs: 180_000,
  idleTimeoutMs: 30_000,
};

function handle(id: number, path: string, generation: number): EngineHandle {
  const ip = `172.31.250.${String(100 + id)}`;
  return {
    containerId: `c${String(id)}`,
    name: `aceswarm-engine-shared-${path}-${String(generation)}`,
    streamId: "",
    generation,
    ip,
    baseUrl: `http://${ip}:6878`,
    sharedPath: path,
  };
}

/** Shared engines whose Docker side and gateway are fakes. `existing` are engines of a previous run. */
function pool(options: { existing?: EngineHandle[]; failCreate?: boolean; holdReplacements?: boolean } = {}) {
  let containers = [...(options.existing ?? [])];
  let nextId = 10;
  const created: EngineHandle[] = [];
  const removed: string[] = [];
  const revived: string[] = [];
  const assigned: PathAssignment[] = [];
  const unassigned: string[] = [];
  const clock = { now: 1000 };
  /** With `holdReplacements`, replacements answer only once this is resolved. */
  const gate = Promise.withResolvers<undefined>();
  /** Containers that are gone: reviving them fails. */
  const dead = new Set<string>();
  /** Makes the Docker API fail once, like a hiccup of the socket proxy. */
  const docker = { fail: false };
  const engines = {
    findShared: (path?: string) =>
      Promise.resolve(containers.filter((engine) => path === undefined || engine.sharedPath === path)),
    createShared: async (path: string, generation: number, onAddress?: OnEngineAddress) => {
      if (options.failCreate === true) {
        throw new Error("engine did not become ready");
      }
      const engine = handle(nextId, path, generation);
      nextId += 1;
      containers.push(engine);
      await onAddress?.(engine);
      if (options.holdReplacements === true && generation > 1) {
        await gate.promise;
      }
      created.push(engine);
      return engine;
    },
    revive: async (engine: EngineHandle, onAddress?: OnEngineAddress) => {
      revived.push(engine.containerId);
      if (docker.fail) {
        docker.fail = false;
        throw new Error("docker GET /containers/x/json failed: socket hang up");
      }
      if (dead.has(engine.containerId)) {
        throw new EngineGoneError(`engine ${engine.name} disappeared`);
      }
      await onAddress?.(engine);
      return engine;
    },
    remove: (engine: EngineHandle) => {
      removed.push(engine.containerId);
      containers = containers.filter((candidate) => candidate.containerId !== engine.containerId);
      return Promise.resolve();
    },
  } as unknown as EngineManager;
  const netgw = {
    assign: (assignment: PathAssignment) => {
      assigned.push(assignment);
      return Promise.resolve();
    },
    unassign: (ip: string) => {
      unassigned.push(ip);
      return Promise.resolve();
    },
  } as unknown as NetgwClient;
  const registry = new Registry();
  const shared = new SharedEngines({
    engines,
    netgw,
    metrics: new ControllerMetrics(registry, () => ({ streams: [], paths: [] })),
    logger: createLogger("test", "silent"),
    settings,
    now: () => clock.now,
  });
  return { shared, created, removed, revived, assigned, unassigned, clock, registry, gate, dead, docker };
}

/** Lets replacements started in the background finish. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await setImmediate();
  }
}

const unwatched = { watched: false, wantsRestart: false, hadVideo: true };
const watched = { watched: true, wantsRestart: false, hadVideo: true };

test("streams on the same path share one engine, which gets the path at the gateway", async () => {
  const { shared, created, assigned } = pool();
  const [a, b] = await Promise.all([shared.acquire("direct", "s1"), shared.acquire("direct", "s2")]);
  expect(a).toBe(b);
  expect(created).toHaveLength(1);
  expect(a.sharedPath).toBe("direct");
  expect(assigned).toEqual([{ ip: a.ip, path: "direct" }]);
  expect(shared.assignments()).toEqual([{ ip: a.ip, path: "direct" }]);
  expect(shared.isCurrent(a)).toBe(true);

  // Another path gets its own engine.
  const vpn = await shared.acquire("wg:a", "s3");
  expect(vpn.containerId).not.toBe(a.containerId);
  expect(shared.view()).toEqual([
    { path: "direct", engine: a.name, streams: 2, retiring: false },
    { path: "wg:a", engine: vpn.name, streams: 1, retiring: false },
  ]);
});

test("removes an engine once its last stream left", async () => {
  const { shared, removed, unassigned } = pool();
  const engine = await shared.acquire("direct", "s1");
  await shared.acquire("direct", "s2");
  await shared.release(engine, "s1");
  expect(removed).toEqual([]);
  await shared.release(engine, "s2");
  expect(removed).toEqual([engine.containerId]);
  expect(unassigned).toEqual([engine.ip]);
  expect(shared.assignments()).toEqual([]);

  // The next stream on the path starts a new one.
  const next = await shared.acquire("direct", "s3");
  expect(next.containerId).not.toBe(engine.containerId);
});

test("takes over the engine a previous run left, and removes older ones", async () => {
  const left = handle(1, "direct", 3);
  const older = handle(2, "direct", 2);
  const { shared, created, revived, removed } = pool({ existing: [left, older] });
  const engine = await shared.acquire("direct", "s1");
  expect(engine).toBe(left);
  expect(revived).toEqual([left.containerId]);
  expect(removed).toEqual([older.containerId]);
  expect(created).toEqual([]);
});

/** Three streams on the direct path's shared engine. */
async function threeStreams() {
  const fake = pool();
  const engine = await fake.shared.acquire("direct", "s1");
  await fake.shared.acquire("direct", "s2");
  await fake.shared.acquire("direct", "s3");
  return { ...fake, engine };
}

describe("restarting a shared engine", () => {
  test("keeps the engine while no more than two streams fail", async () => {
    const { shared, engine, created } = await threeStreams();
    expect(shared.reportFailure(engine, "s1", unwatched)).toBe(false);
    expect(shared.reportFailure(engine, "s2", unwatched)).toBe(false);
    // The same stream failing again is still two streams.
    expect(shared.reportFailure(engine, "s2", unwatched)).toBe(false);
    await settle();
    expect(created).toHaveLength(1);
    expect(shared.isCurrent(engine)).toBe(true);
  });

  test("replaces it make-before-break once more than two streams fail within the window", async () => {
    const { shared, engine, created, removed, registry } = await threeStreams();
    shared.reportFailure(engine, "s1", unwatched);
    shared.reportFailure(engine, "s2", unwatched);
    expect(shared.reportFailure(engine, "s3", unwatched)).toBe(true);
    await settle();
    expect(created).toHaveLength(2);
    const replacement = created[1]!;
    expect(replacement.generation).toBe(2);

    // Streams move over one by one; the old engine stays until the last one left.
    expect(shared.isCurrent(engine)).toBe(false);
    expect(shared.isCurrent(replacement)).toBe(true);
    for (const stream of ["s1", "s2"]) {
      await shared.acquire("direct", stream);
      await shared.release(engine, stream);
    }
    expect(removed).toEqual([]);
    expect(shared.assignments()).toHaveLength(2);
    await shared.acquire("direct", "s3");
    await shared.release(engine, "s3");
    expect(removed).toEqual([engine.containerId]);
    expect(shared.assignments()).toEqual([{ ip: replacement.ip, path: "direct" }]);
    expect(await registry.getSingleMetricAsString("aceswarm_shared_engine_restarts_total")).toContain(
      'path="direct",reason="failures"} 1',
    );
  });

  test("doesn't count failures older than the window", async () => {
    const { shared, engine, clock } = await threeStreams();
    shared.reportFailure(engine, "s1", unwatched);
    shared.reportFailure(engine, "s2", unwatched);
    clock.now += settings.failureWindowMs + 1;
    expect(shared.reportFailure(engine, "s3", unwatched)).toBe(false);
  });

  test("replaces it right away when the stream someone watches fails", async () => {
    const { shared, engine, created, registry } = await threeStreams();
    expect(shared.reportFailure(engine, "s2", watched)).toBe(true);
    await settle();
    expect(created).toHaveLength(2);
    expect(await registry.getSingleMetricAsString("aceswarm_shared_engine_restarts_total")).toContain(
      'reason="watched"} 1',
    );
    // Reports about the old engine just say it is being replaced.
    expect(shared.reportFailure(engine, "s1", unwatched)).toBe(true);
  });

  test("replaces it when every stream on it reached the point of restarting its engine", async () => {
    const fake = pool();
    const engine = await fake.shared.acquire("direct", "s1");
    await fake.shared.acquire("direct", "s2");
    expect(fake.shared.reportFailure(engine, "s1", { ...unwatched, wantsRestart: true })).toBe(false);
    // The other stream fails too, but its ladder is not there yet.
    expect(fake.shared.reportFailure(engine, "s2", unwatched)).toBe(false);
    expect(fake.shared.reportFailure(engine, "s2", { ...unwatched, wantsRestart: true })).toBe(true);

    // A stream alone on its engine gets the same engine restarts as with an engine of its own.
    const lone = await fake.shared.acquire("wg:a", "s3");
    expect(fake.shared.reportFailure(lone, "s3", { ...unwatched, wantsRestart: true })).toBe(true);
  });

  test("doesn't count streams that never played from it", async () => {
    const { shared, engine } = await threeStreams();
    const never = { ...unwatched, hadVideo: false };
    // A broadcast that is down fails on any engine.
    expect(shared.reportFailure(engine, "s1", { ...watched, hadVideo: false })).toBe(false);
    expect(shared.reportFailure(engine, "s2", never)).toBe(false);
    expect(shared.reportFailure(engine, "s3", never)).toBe(false);
    // Unless every stream on it fails: the engine may be what is wrong.
    expect(shared.reportFailure(engine, "s3", { ...never, wantsRestart: true })).toBe(true);
  });

  test("replaces it at most once per failure window, unless asked to", async () => {
    const { shared, engine, created, clock } = await threeStreams();
    expect(shared.reportFailure(engine, "s1", watched)).toBe(true);
    await settle();
    const replacement = await shared.acquire("direct", "s1");
    await shared.release(engine, "s1");
    expect(replacement).toBe(created[1]);
    // The watched stream fails again on the new engine: its own recovery goes on.
    expect(shared.reportFailure(replacement, "s1", watched)).toBe(false);
    clock.now += settings.failureWindowMs;
    expect(shared.reportFailure(replacement, "s1", watched)).toBe(true);
    await settle();
    expect(shared.restart(created[2]!)).toBe(true);
  });

  test("gives a replacement its gateway path while it starts", async () => {
    const fake = pool({ holdReplacements: true });
    const engine = await fake.shared.acquire("direct", "s1");
    fake.shared.restart(engine);
    await settle();
    const starting = fake.assigned.at(-1)!;
    expect(starting.ip).not.toBe(engine.ip);
    // The periodic sync keeps it at the gateway while its API doesn't answer yet.
    expect(fake.shared.assignments()).toEqual([
      { ip: engine.ip, path: "direct" },
      { ip: starting.ip, path: "direct" },
    ]);
    expect(fake.shared.isCurrent(engine)).toBe(true);
    fake.gate.resolve(undefined);
    await settle();
    expect(fake.shared.isCurrent(engine)).toBe(false);
  });

  test("streams that come once the old engine is gone wait for its replacement", async () => {
    const fake = pool({ holdReplacements: true });
    const engine = await fake.shared.acquire("direct", "s1");
    fake.shared.restart(engine);
    await fake.shared.release(engine, "s1");
    expect(fake.removed).toEqual([engine.containerId]);
    const next = fake.shared.acquire("direct", "s2");
    fake.gate.resolve(undefined);
    const replacement = await next;
    expect(fake.created.map(({ generation }) => generation)).toEqual([1, 2]);
    expect(fake.shared.isCurrent(replacement)).toBe(true);
    expect(fake.removed).toEqual([engine.containerId]);
  });

  test("restarts on request", async () => {
    const { shared, engine, created } = await threeStreams();
    expect(shared.restart(engine)).toBe(true);
    await settle();
    expect(created).toHaveLength(2);
  });

  test("waits a window before trying again when the replacement doesn't start", async () => {
    const fake = pool({ existing: [handle(1, "direct", 1)], failCreate: true });
    const engine = await fake.shared.acquire("direct", "s1");
    expect(fake.shared.reportFailure(engine, "s1", watched)).toBe(true);
    await settle();
    // Creating failed: the old engine stays current, and it isn't tried again right away.
    expect(fake.shared.isCurrent(engine)).toBe(true);
    expect(fake.shared.reportFailure(engine, "s1", watched)).toBe(false);
    fake.clock.now += settings.failureWindowMs + 1;
    expect(fake.shared.reportFailure(engine, "s1", watched)).toBe(true);
  });
});

describe("starting again on the same engine", () => {
  test("counts the stream on it again once it answers", async () => {
    const { shared, revived, removed } = pool();
    const engine = await shared.acquire("direct", "s1");
    await shared.acquire("direct", "s2");
    await shared.release(engine, "s1");
    expect(await shared.rejoin(engine, "s1")).toBe(engine);
    expect(revived).toEqual([engine.containerId]);
    await shared.release(engine, "s2");
    expect(removed).toEqual([]);
  });

  test("replaces an engine that is gone", async () => {
    const fake = pool();
    const engine = await fake.shared.acquire("direct", "s1");
    fake.dead.add(engine.containerId);
    const next = await fake.shared.rejoin(engine, "s1");
    expect(next.containerId).not.toBe(engine.containerId);
    expect(fake.removed).toEqual([engine.containerId]);
    expect(fake.shared.isCurrent(next)).toBe(true);
    expect(await fake.registry.getSingleMetricAsString("aceswarm_shared_engine_restarts_total")).toContain(
      'reason="unresponsive"} 1',
    );
  });

  test("keeps an engine the Docker API failed to tell about", async () => {
    const fake = pool();
    const engine = await fake.shared.acquire("direct", "s1");
    await fake.shared.acquire("direct", "s2");
    fake.docker.fail = true;
    await expect(fake.shared.rejoin(engine, "s1")).rejects.toThrow("socket hang up");
    expect(fake.shared.isCurrent(engine)).toBe(true);
    expect(fake.removed).toEqual([]);
    expect(fake.unassigned).toEqual([]);
    expect(await fake.shared.rejoin(engine, "s1")).toBe(engine);
  });
});

describe("sweeping", () => {
  test("removes a replacement no stream moved to, after the idle timeout", async () => {
    const { shared, created, removed, clock } = pool();
    const engine = await shared.acquire("direct", "s1");
    shared.restart(engine);
    await settle();
    // The only stream went away before moving.
    await shared.release(engine, "s1");
    const replacement = created[1]!;
    await shared.sweep();
    expect(removed).toEqual([engine.containerId]);
    clock.now += settings.idleTimeoutMs;
    await shared.sweep();
    expect(removed).toEqual([engine.containerId, replacement.containerId]);
  });

  test("keeps a replacement while streams still move to it", async () => {
    const { shared, created, removed, clock } = pool();
    const engine = await shared.acquire("direct", "s1");
    shared.restart(engine);
    await settle();
    // The stream takes long to move (a handover, a path that is down for a while).
    clock.now += settings.idleTimeoutMs * 3;
    await shared.sweep();
    expect(removed).toEqual([]);
    await shared.acquire("direct", "s1");
    await shared.release(engine, "s1");
    expect(removed).toEqual([engine.containerId]);
    expect(shared.isCurrent(created[1]!)).toBe(true);
  });

  test("removes engines of a previous run that no stream took", async () => {
    const left = handle(1, "wg:gone", 1);
    const { shared, removed } = pool({ existing: [left] });
    await shared.acquire("direct", "s1");
    await shared.sweep();
    expect(removed).toEqual([left.containerId]);
  });
});
