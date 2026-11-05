import { Registry } from "@prometheus-io/client";
import type { PathAssignment, PathStatus, PipelineStatus } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, test } from "vitest";
import type { AcestreamClient, EngineSession } from "../src/acestream.ts";
import type { NetgwClient, TranscoderClient } from "../src/clients.ts";
import type { EngineHandle, EngineManager, OnEngineAddress } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import type { StreamConfig, StreamStore } from "../src/stream-store.ts";
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
  const engines = {
    find: () => Promise.resolve([]),
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
    status: () =>
      Promise.resolve(
        pending !== undefined && fakes.handover === "delivers"
          ? { ...pipeline, source: pending, lastFrameAt: new Date(clock.now).toISOString() }
          : pipeline,
      ),
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
    pathLoad: () => new Map(),
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  return { instance, assigned, assignedWhenReady, unassigned, removed, clock };
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
