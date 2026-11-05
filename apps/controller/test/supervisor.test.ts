import { Registry } from "@prometheus-io/client";
import type { PathAssignment, PathStatus, PipelineStatus } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, test } from "vitest";
import type { AcestreamClient, EngineSession } from "../src/acestream.ts";
import type { NetgwClient, TranscoderClient } from "../src/clients.ts";
import type { EngineHandle, EngineManager, OnEngineAddress } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import type { FailureReport, SharedEngines } from "../src/shared-engines.ts";
import type { StreamConfig, StreamStore } from "../src/stream-store.ts";
import { MoveSlots } from "../src/stream-paths.ts";
import { StreamSupervisor, type SupervisorSettings } from "../src/supervisor.ts";

const settings: SupervisorSettings = {
  tickMs: 1000,
  stallAfterMs: 20_000,
  startupGraceMs: 60_000,
  recoveryBaseDelayMs: 1000,
  recoveryMaxDelayMs: 60_000,
  handoverTimeoutMs: 30_000,
  pathStrategy: "sticky-best",
  pathMinDwellMs: 300_000,
};

const direct: PathStatus = {
  id: "direct",
  kind: "direct",
  label: "Direct",
  up: true,
  rttMs: 20,
  loss: 0,
  handshakeAgeSeconds: null,
  score: 0.9,
  lastProbeAt: null,
  error: null,
};

const engine: EngineHandle = {
  containerId: "c1",
  name: "aceswarm-engine-s1-1",
  streamId: "s1",
  generation: 1,
  ip: "172.31.250.10",
  baseUrl: "http://172.31.250.10:6878",
  sharedPath: null,
};

const session: EngineSession = {
  playbackUrl: "http://172.31.250.10:6878/play",
  statUrl: "http://172.31.250.10:6878/stat",
  commandUrl: "http://172.31.250.10:6878/cmd",
};

const pipeline: PipelineStatus = {
  id: "s1",
  state: "running",
  source: session.playbackUrl,
  startedAt: new Date(0).toISOString(),
  lastFrameAt: null,
  frames: 0,
  fps: null,
  videoCodec: null,
  mode: "copy",
  exitCode: null,
  error: null,
  pendingSource: null,
};

const stream: StreamConfig = {
  id: "s1",
  aceId: "a".repeat(40),
  aceIdKind: "content-id",
  name: "Test",
  enabled: true,
  createdAt: new Date(0).toISOString(),
  path: null,
};

interface Fakes {
  /** Engines handed out by `create`, in order (the last one repeats). */
  created?: EngineHandle[];
  /** Fails the first session start, like an engine that dies right away. */
  failFirstSession?: boolean;
  /** Whether video arrives from the new engine when a stream moves to another path. */
  handover?: "delivers" | "stops";
  /** Makes removing an engine fail. */
  failRemove?: boolean;
  /** The network policy's rule for paths (all allowed by default). */
  pathAllowed?: (path: string) => boolean;
  /** Slots shared by the streams moving off a path the policy turned off. */
  policyMoves?: MoveSlots;
  /** The shared engines, and whether sharing is on. */
  shared?: SharedEngines;
  sharing?: { on: boolean };
  /** Players showing the stream. */
  viewers?: number;
  /** While on, the pipeline receives video. */
  video?: { on: boolean };
}

/** A supervisor whose dependencies are fakes; `paths` is what the gateway reports. */
function supervisor(paths: PathStatus[], fakes: Fakes = {}) {
  const assigned: PathAssignment[] = [];
  const unassigned: string[] = [];
  const clock = { now: 1000 };
  const created = [...(fakes.created ?? [engine])];
  // The gateway assignments as they were each time an engine's API first answered.
  const assignedWhenReady: PathAssignment[][] = [];
  const removed: string[] = [];
  const restarted: string[] = [];
  const engines = {
    find: () => Promise.resolve([]),
    removeAllFor: () => Promise.resolve(),
    restart: async (handle: EngineHandle, onAddress?: OnEngineAddress) => {
      restarted.push(handle.containerId);
      await onAddress?.(handle);
      return handle;
    },
    remove: (handle: EngineHandle) => {
      removed.push(handle.containerId);
      return fakes.failRemove === true ? Promise.reject(new Error("docker said no")) : Promise.resolve();
    },
    create: async (_streamId: string, _generation: number, onAddress?: OnEngineAddress) => {
      const handle = (created.length > 1 ? created.shift() : created[0]) ?? engine;
      await onAddress?.(handle);
      assignedWhenReady.push([...assigned]);
      return handle;
    },
  } as unknown as EngineManager;
  let sessions = 0;
  const ace = {
    startSession: (baseUrl: string) => {
      sessions += 1;
      return fakes.failFirstSession === true && sessions === 1
        ? Promise.reject(new Error("engine died"))
        : Promise.resolve({ playbackUrl: `${baseUrl}/play`, statUrl: `${baseUrl}/stat`, commandUrl: `${baseUrl}/cmd` });
    },
    stopSession: () => Promise.resolve(),
    stats: () => Promise.resolve({ status: "dl", peers: 1, speedDown: 0, speedUp: 0, downloaded: 0, uploaded: 0 }),
  } as unknown as AcestreamClient;
  // The source a path move asked the transcoder to cut over to.
  let pending: string | undefined;
  const transcoder = {
    start: (_id: string, input: { source: string }, handover?: boolean) => {
      pending = handover === true ? input.source : undefined;
      return Promise.resolve(pipeline);
    },
    status: () => {
      const delivers = fakes.video?.on === true || (pending !== undefined && fakes.handover === "delivers");
      const source = pending ?? pipeline.source;
      return Promise.resolve(
        delivers ? { ...pipeline, source, lastFrameAt: new Date(clock.now).toISOString() } : pipeline,
      );
    },
  } as unknown as TranscoderClient;
  const netgw = {
    assign: (assignment: PathAssignment) => {
      assigned.push(assignment);
      return Promise.resolve();
    },
    unassign: (ip: string) => {
      unassigned.push(ip);
      return Promise.resolve();
    },
    peers: () => Promise.reject(new Error("no peers")),
  } as unknown as NetgwClient;
  const store = { update: () => Promise.resolve() } as unknown as StreamStore;
  const metrics = new ControllerMetrics(new Registry(), () => ({ streams: [], paths: [] }));
  const instance = new StreamSupervisor(stream, {
    engines,
    ace,
    transcoder,
    netgw,
    store,
    metrics,
    logger: createLogger("test", "silent"),
    settings,
    paths: () => paths,
    ...(fakes.pathAllowed !== undefined && { pathAllowed: fakes.pathAllowed }),
    ...(fakes.policyMoves !== undefined && { policyMoves: fakes.policyMoves }),
    ...(fakes.shared !== undefined && { shared: fakes.shared }),
    sharedEngines: () => fakes.sharing?.on === true,
    viewers: () => fakes.viewers ?? 0,
    pathLoad: () => new Map(),
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  return { instance, assigned, assignedWhenReady, unassigned, removed, restarted, clock };
}

test("gives an engine a path at start when the gateway's paths are known", async () => {
  const { instance, assigned } = supervisor([direct]);
  await instance.tick();
  expect(assigned).toEqual([{ ip: engine.ip, path: "direct" }]);
  expect(instance.assignments()).toEqual([{ ip: engine.ip, path: "direct" }]);
  expect(instance.settled).toBe(true);

  // Later ticks don't assign it again; the orchestrator re-sends it with the full list.
  await instance.tick();
  expect(assigned).toHaveLength(1);
});

test("gives a starting engine its path before its API answers", async () => {
  // The gateway blocks an engine without a path, and a real engine's API only answers once its
  // first DNS lookups are done: assigning the path after that made every start wait them out.
  const { instance, assignedWhenReady } = supervisor([direct]);
  await instance.tick();
  expect(assignedWhenReady).toEqual([[{ ip: engine.ip, path: "direct" }]]);
});

test("assigns a path once the gateway's paths are known, when the stream started without them", async () => {
  const paths: PathStatus[] = [];
  const { instance, assigned } = supervisor(paths);
  await instance.tick();
  expect(assigned).toEqual([]);
  expect(instance.assignments()).toEqual([]);

  // The gateway is back: without a path, it would keep blocking the engine.
  paths.push(direct);
  await instance.tick();
  expect(assigned).toEqual([{ ip: engine.ip, path: "direct" }]);
  expect(instance.path).toBe("direct");
});

test("waits without restarting anything while no path is up, then gives the engine time to start", async () => {
  const paths: PathStatus[] = [];
  const { instance, assigned, restarted, clock } = supervisor(paths);
  // The gateway's paths are unknown while the stream starts, so its engine has no path yet.
  await instance.tick();
  paths.push({ ...direct, up: false });
  clock.now += settings.startupGraceMs + 1000;
  await instance.tick();
  await instance.tick();
  expect(assigned).toEqual([]);
  expect(restarted).toEqual([]);
  expect(instance.view()).toMatchObject({ state: "stalled", message: "no network path is up; waiting for one" });

  // A path comes up: the engine was cut off until now, so it gets the startup grace again instead
  // of being restarted straight away for having shown no video.
  paths[0] = direct;
  await instance.tick();
  expect(assigned).toEqual([{ ip: engine.ip, path: "direct" }]);
  expect(instance.view()).toMatchObject({ state: "starting", recoveries: 0 });
});

test("stops sending the address of an engine that was replaced", async () => {
  const replacement: EngineHandle = { ...engine, containerId: "c2", generation: 2, ip: "172.31.250.11" };
  const { instance, assigned, unassigned, clock } = supervisor([direct], {
    created: [engine, replacement],
    failFirstSession: true,
  });
  await instance.tick();
  expect(instance.assignments()).toEqual([{ ip: engine.ip, path: "direct" }]);

  // The engine died before playing; the next start gets a new engine on a new address.
  clock.now += 60_000;
  await instance.tick();

  expect(assigned.at(-1)).toEqual({ ip: replacement.ip, path: "direct" });
  expect(unassigned).toEqual([engine.ip]);
  expect(instance.assignments()).toEqual([{ ip: replacement.ip, path: "direct" }]);
});

describe("moving a stream to another path", () => {
  const vpn: PathStatus = { ...direct, id: "wg:a", kind: "wireguard", label: "VPN", score: 0.5 };
  const replacement: EngineHandle = {
    ...engine,
    containerId: "c2",
    generation: 2,
    ip: "172.31.250.11",
    baseUrl: "http://172.31.250.11:6878",
  };

  /** Starts the stream on the direct path, then takes that path down while no video arrives. */
  async function moveOffDirect(fakes: Fakes) {
    const paths = [direct, vpn];
    const fake = supervisor(paths, { created: [engine, replacement], ...fakes });
    await fake.instance.tick();
    paths[0] = { ...direct, up: false };
    fake.clock.now += settings.startupGraceMs + 1000;
    await fake.instance.tick();
    return fake;
  }

  test("removes only the engine it started when the new path brings no video", async () => {
    const { instance, assigned, unassigned, removed } = await moveOffDirect({ handover: "stops" });
    expect(assigned.at(-1)).toEqual({ ip: replacement.ip, path: "wg:a" });
    expect(removed).toEqual([replacement.containerId]);
    expect(unassigned).toEqual([replacement.ip]);
    expect(instance.assignments()).toEqual([{ ip: engine.ip, path: "direct" }]);
    expect(instance.path).toBe("direct");
  });

  test("keeps the new engine once video arrives, even when removing the old one fails", async () => {
    const { instance, removed } = await moveOffDirect({ handover: "delivers", failRemove: true });
    expect(instance.path).toBe("wg:a");
    expect(removed).toEqual([engine.containerId]);
    expect(instance.assignments()).toEqual([{ ip: replacement.ip, path: "wg:a" }]);
  });
});

/** The policy as the orchestrator applies it; flip `on` to turn WireGuard only on or off. */
function policy(on: boolean) {
  const state = { on };
  return { state, pathAllowed: (path: string) => !state.on || path !== "direct" };
}

describe("WireGuard only", () => {
  const vpn: PathStatus = { ...direct, id: "wg:a", kind: "wireguard", label: "VPN", score: 0.5 };
  const replacement: EngineHandle = {
    ...engine,
    containerId: "c2",
    generation: 2,
    ip: "172.31.250.11",
    baseUrl: "http://172.31.250.11:6878",
  };
  test("never gives an engine the direct path, even when it scores best", async () => {
    const { pathAllowed } = policy(true);
    const { instance, assigned } = supervisor([direct, vpn], { pathAllowed });
    await instance.tick();
    expect(assigned).toEqual([{ ip: engine.ip, path: "wg:a" }]);
    expect(instance.path).toBe("wg:a");
  });

  test("starts no engine while no WireGuard path is up, and starts one once a path is up", async () => {
    const { pathAllowed } = policy(true);
    const paths = [direct, { ...vpn, up: false }];
    const { instance, assigned, assignedWhenReady } = supervisor(paths, { pathAllowed });
    await instance.tick();
    await instance.tick();
    expect(assignedWhenReady).toEqual([]);
    expect(assigned).toEqual([]);
    expect(instance.view().state).toBe("stalled");
    expect(instance.view().message).toContain("WireGuard only is on");
    // Its paths are complete (it has none), so the orchestrator may sync the gateway.
    expect(instance.settled).toBe(true);

    paths[1] = vpn;
    await instance.tick();
    expect(assigned).toEqual([{ ip: engine.ip, path: "wg:a" }]);
  });

  test("moves a stream off the direct path right away, without counting a recovery", async () => {
    const { state, pathAllowed } = policy(false);
    const { instance, assigned, removed, unassigned } = supervisor([direct, vpn], {
      created: [engine, replacement],
      handover: "delivers",
      pathAllowed,
    });
    await instance.tick();
    expect(instance.path).toBe("direct");

    state.on = true;
    await instance.tick();

    expect(instance.path).toBe("wg:a");
    expect(assigned.at(-1)).toEqual({ ip: replacement.ip, path: "wg:a" });
    expect(instance.assignments()).toEqual([{ ip: replacement.ip, path: "wg:a" }]);
    expect(removed).toEqual([engine.containerId]);
    expect(unassigned).toEqual([engine.ip]);
    expect(instance.view().recoveries).toBe(0);
  });

  test("waits before trying again when the move brings no video", async () => {
    const { state, pathAllowed } = policy(false);
    const { instance, assignedWhenReady, clock } = supervisor([direct, vpn], {
      created: [engine, replacement],
      handover: "stops",
      pathAllowed,
    });
    await instance.tick();
    state.on = true;
    await instance.tick();
    expect(instance.path).toBe("direct");
    expect(assignedWhenReady).toHaveLength(2);
    expect(instance.view().message).toContain("moving off direct failed");

    // The next tick doesn't start yet another engine.
    await instance.tick();
    expect(assignedWhenReady).toHaveLength(2);
    expect(instance.view().message).toMatch(/path direct is off; moving again in \d+s/);

    clock.now += settings.recoveryMaxDelayMs;
    await instance.tick();
    expect(assignedWhenReady).toHaveLength(3);
  });

  test("never moves a stalled stream to the direct path, even when it scores better", async () => {
    const { pathAllowed } = policy(true);
    const paths = [direct, vpn];
    const { instance, assigned, clock } = supervisor(paths, { pathAllowed, created: [engine, replacement] });
    await instance.tick();
    expect(instance.path).toBe("wg:a");

    // The tunnel dies while direct stays up. Without the policy, the first recovery would move.
    paths[1] = { ...vpn, up: false };
    for (let tick = 0; tick < 40; tick += 1) {
      clock.now += 10_000;
      await instance.tick();
    }
    expect(instance.view().recoveries).toBeGreaterThan(3);
    expect(assigned.map(({ path }) => path)).not.toContain("direct");
    expect(instance.path).toBe("wg:a");
  });

  test("waits for the gateway instead of restarting the engine while its paths are unknown", async () => {
    const { state, pathAllowed } = policy(false);
    const paths: PathStatus[] = [direct, vpn];
    const { instance, assigned, restarted, assignedWhenReady } = supervisor(paths, { pathAllowed });
    await instance.tick();
    state.on = true;
    // The gateway restarts just then.
    paths.length = 0;
    for (let tick = 0; tick < 3; tick += 1) {
      await instance.tick();
    }
    expect(restarted).toEqual([]);
    expect(assignedWhenReady).toHaveLength(1);
    expect(assigned).toEqual([{ ip: engine.ip, path: "direct" }]);
    expect(instance.view().message).toBe("waiting for the network gateway");
  });

  test("a manual restart puts the engine on a path it may use", async () => {
    const { state, pathAllowed } = policy(false);
    const { instance, assigned, restarted } = supervisor([direct, vpn], { pathAllowed });
    await instance.tick();
    state.on = true;
    instance.requestRestart();
    await instance.tick();
    expect(restarted).toEqual([engine.containerId]);
    expect(assigned.at(-1)).toEqual({ ip: engine.ip, path: "wg:a" });
    expect(instance.path).toBe("wg:a");
  });

  test("waits for a free slot before moving, so few streams move at once", async () => {
    const { state, pathAllowed } = policy(false);
    const policyMoves = new MoveSlots(1);
    const { instance, assignedWhenReady } = supervisor([direct, vpn], {
      created: [engine, replacement],
      handover: "delivers",
      pathAllowed,
      policyMoves,
    });
    await instance.tick();
    state.on = true;
    // Another stream is moving.
    expect(policyMoves.tryTake()).toBe(true);
    await instance.tick();
    expect(assignedWhenReady).toHaveLength(1);
    expect(instance.view().message).toBe("path direct is off; other streams move first");

    policyMoves.release();
    await instance.tick();
    expect(instance.path).toBe("wg:a");
    // The slot is free again once the move is done.
    expect(policyMoves.tryTake()).toBe(true);
  });

  test("stays on its WireGuard path when WireGuard only is turned off", async () => {
    const { state, pathAllowed } = policy(true);
    const { instance, assigned } = supervisor([direct, vpn], { pathAllowed });
    await instance.tick();
    state.on = false;
    await instance.tick();
    await instance.tick();
    expect(assigned).toEqual([{ ip: engine.ip, path: "wg:a" }]);
    expect(instance.path).toBe("wg:a");
  });
});

/** Lets the stream stall: no video ever arrives, so every check after the grace is a failure. */
async function stallAndRecover(fake: ReturnType<typeof supervisor>, steps: number) {
  for (let step = 0; step < steps; step += 1) {
    // Past the start's grace and the recovery delay.
    fake.clock.now += Math.max(settings.startupGraceMs, settings.recoveryMaxDelayMs) + 1000;
    await fake.instance.tick();
  }
}

describe("sharing one engine per path", () => {
  const sharedEngine: EngineHandle = {
    ...engine,
    containerId: "shared-1",
    name: "aceswarm-engine-shared-direct-1",
    streamId: "",
    ip: "172.31.250.20",
    baseUrl: "http://172.31.250.20:6878",
    sharedPath: "direct",
  };

  /** Shared engines that hand out `current`; `replace` makes another engine current. */
  function sharedEngines() {
    const state = { current: sharedEngine };
    const acquired: string[] = [];
    const released: string[] = [];
    const reports: FailureReport[] = [];
    const restarts: string[] = [];
    const rejoined: string[] = [];
    const shared = {
      acquire: (path: string) => {
        acquired.push(path);
        return Promise.resolve(state.current);
      },
      rejoin: (handle: EngineHandle) => {
        rejoined.push(handle.containerId);
        return Promise.resolve(state.current);
      },
      release: (handle: EngineHandle) => {
        released.push(handle.containerId);
        return Promise.resolve();
      },
      isCurrent: (handle: EngineHandle) => handle.containerId === state.current.containerId,
      reportFailure: (_handle: EngineHandle, _stream: string, report: FailureReport) => {
        reports.push(report);
        return report.watched && report.hadVideo;
      },
      restart: (handle: EngineHandle) => {
        restarts.push(handle.containerId);
        return true;
      },
    } as unknown as SharedEngines;
    return { shared, state, acquired, released, reports, restarts, rejoined };
  }

  test("plays from its path's shared engine, whose gateway path the shared engines manage", async () => {
    const pool = sharedEngines();
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true } });
    await fake.instance.tick();
    expect(pool.acquired).toEqual(["direct"]);
    expect(fake.assignedWhenReady).toEqual([]);
    expect(fake.instance.assignments()).toEqual([]);
    expect(fake.instance.path).toBe("direct");
    expect(fake.instance.view().engine).toEqual({ name: sharedEngine.name, shared: true });
  });

  test("restarts only its session, and leaves the engine to the shared engines' rules", async () => {
    const pool = sharedEngines();
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true } });
    await fake.instance.tick();
    await stallAndRecover(fake, 3);
    // The ladder's third step would restart its own engine: on a shared one it only says so.
    // It never played from the engine, which the shared engines take into account.
    expect(pool.reports).toEqual([
      { watched: false, wantsRestart: false, hadVideo: false },
      { watched: false, wantsRestart: false, hadVideo: false },
      { watched: false, wantsRestart: true, hadVideo: false },
    ]);
    expect(fake.restarted).toEqual([]);
    expect(fake.instance.view().recoveries).toBe(3);
  });

  test("says when someone watches it after it played from the engine, which replaces the engine", async () => {
    const pool = sharedEngines();
    const video = { on: true };
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true }, viewers: 1, video });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    video.on = false;
    await stallAndRecover(fake, 1);
    expect(pool.reports).toEqual([{ watched: true, wantsRestart: false, hadVideo: true }]);
    expect(fake.instance.view().message).toContain("replacing the shared engine");
  });

  test("doesn't blame the shared engine while its path is down", async () => {
    const pool = sharedEngines();
    const paths = [direct];
    const fake = supervisor(paths, { shared: pool.shared, sharing: { on: true } });
    await fake.instance.tick();
    paths[0] = { ...direct, up: false };
    await stallAndRecover(fake, 1);
    expect(pool.reports).toEqual([]);
  });

  test("starting again on the same shared engine checks that it still answers", async () => {
    const pool = sharedEngines();
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true }, failFirstSession: true });
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("error");
    await stallAndRecover(fake, 1);
    expect(pool.acquired).toEqual(["direct"]);
    expect(pool.rejoined).toEqual([sharedEngine.containerId]);
    expect(fake.instance.view().state).toBe("starting");
  });

  test("moves to the new engine once the shared one was replaced", async () => {
    const pool = sharedEngines();
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true } });
    await fake.instance.tick();
    const replacement = { ...sharedEngine, containerId: "shared-2", name: "aceswarm-engine-shared-direct-2" };
    pool.state.current = replacement;
    await fake.instance.tick();
    expect(pool.acquired).toEqual(["direct", "direct"]);
    expect(pool.released).toEqual([sharedEngine.containerId]);
    expect(fake.instance.view().engine?.name).toBe(replacement.name);
  });

  test("moves to an engine of its own once sharing is turned off, and back once it is on", async () => {
    const pool = sharedEngines();
    const sharing = { on: true };
    const fake = supervisor([direct], { shared: pool.shared, sharing });
    await fake.instance.tick();

    sharing.on = false;
    await fake.instance.tick();
    expect(fake.assigned).toEqual([{ ip: engine.ip, path: "direct" }]);
    expect(pool.released).toEqual([sharedEngine.containerId]);
    expect(fake.instance.view().engine).toEqual({ name: engine.name, shared: false });
    expect(fake.instance.assignments()).toEqual([{ ip: engine.ip, path: "direct" }]);

    sharing.on = true;
    await fake.instance.tick();
    expect(fake.removed).toEqual([engine.containerId]);
    expect(fake.unassigned).toEqual([engine.ip]);
    expect(fake.instance.view().engine).toEqual({ name: sharedEngine.name, shared: true });
  });

  test("a manual restart replaces the shared engine and restarts the stream's session", async () => {
    const pool = sharedEngines();
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true } });
    await fake.instance.tick();
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(pool.restarts).toEqual([sharedEngine.containerId]);
    expect(fake.restarted).toEqual([]);
  });
});
