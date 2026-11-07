import { setImmediate } from "node:timers/promises";
import { Registry } from "@prometheus-io/client";
import type { PathAssignment, PathStatus, PipelineStatus } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, test } from "vitest";
import type { AcestreamClient, EngineSession } from "../src/acestream.ts";
import type { NetgwClient, TranscoderClient } from "../src/clients.ts";
import { EngineGoneError, type EngineHandle, type EngineManager, type OnEngineAddress } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import type { FailureReport, SharedEngines } from "../src/shared-engines.ts";
import { DEFAULT_STANDBY_SETTINGS, type StandbySettings } from "../src/standby.ts";
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
  ownEngine: null,
};

interface Fakes {
  /** Engines handed out by `create`, in order (the last one repeats). */
  created?: EngineHandle[];
  /** Fails the first session start, like an engine that dies right away. */
  failFirstSession?: boolean;
  /** Whether video arrives from the new engine when a stream moves to another path (a holder can change it). */
  handover?: "delivers" | "stops" | { value: "delivers" | "stops" };
  /** Makes removing an engine fail. */
  failRemove?: boolean;
  /** The network policy's rule for paths (all allowed by default). */
  pathAllowed?: (path: string) => boolean;
  /** Slots shared by the streams moving off a path the policy turned off. */
  policyMoves?: MoveSlots;
  /** Slots shared by every stream's kept engines. */
  spareSlots?: MoveSlots;
  /** The shared engines, and whether sharing is on. */
  shared?: SharedEngines;
  sharing?: { on: boolean };
  /** Players showing the stream. */
  viewers?: number;
  /** While on, the pipeline receives video. */
  video?: { on: boolean };
  /** Engines of the stream left from a previous run, newest first. */
  found?: EngineHandle[];
  /** The own engine the stream played from before the controller restarted. */
  ownEngine?: string;
  /** Engines (container ids) that are gone when taken over. */
  gone?: Set<string>;
  /** While on, engines no longer know the sessions opened earlier. */
  sessionsForgotten?: { on: boolean };
  /** While on, taking over an engine fails the way a Docker API error does. */
  reviveFails?: { on: boolean };
  /** Engines that come back on another address when taken over, by container id. */
  reviveAs?: Map<string, EngineHandle>;
  /**
   * A transcoder that works like the real one: the playback URLs that deliver video. A handover
   * keeps the current source until the new one delivers, and only when the current one delivers;
   * otherwise the new source is the only one at once. A handover that doesn't deliver in time goes.
   */
  sources?: Set<string>;
  /** Playback URLs that start to deliver at a time on the fake clock, added to `sources` then. */
  arrives?: Map<string, number>;
  /** Playback URLs whose current ffmpeg exits at a time on the fake clock; a new start clears it. */
  exits?: Map<string, number>;
  /** While on, the stream keeps hot standbys on the other paths (off by default). */
  hotStandby?: { on: boolean };
  standby?: Partial<StandbySettings>;
  /** Slots shared by every stream's starting standbys. */
  standbyStarts?: MoveSlots;
  /** The playback URLs whose standby readers get data (`sources` by default). */
  standbyData?: Set<string>;
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
  const revived: string[] = [];
  let creates = 0;
  const engines = {
    find: () => Promise.resolve(fakes.found ?? []),
    revive: async (handle: EngineHandle, onAddress?: OnEngineAddress) => {
      revived.push(handle.containerId);
      if (fakes.gone?.has(handle.containerId) === true) {
        throw new EngineGoneError("engine exited with code 137");
      }
      if (fakes.reviveFails?.on === true) {
        throw new Error("docker said no");
      }
      const revivedAs = fakes.reviveAs?.get(handle.containerId) ?? handle;
      await onAddress?.(revivedAs);
      return revivedAs;
    },
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
      creates += 1;
      const handle = (created.length > 1 ? created.shift() : created[0]) ?? engine;
      await onAddress?.(handle);
      assignedWhenReady.push([...assigned]);
      return handle;
    },
    ownName: (streamId: string, generation: number) => `aceswarm-engine-${streamId}-${String(generation)}`,
  } as unknown as EngineManager;
  let sessions = 0;
  const stopped: string[] = [];
  const ace = {
    startSession: (baseUrl: string) => {
      sessions += 1;
      return fakes.failFirstSession === true && sessions === 1
        ? Promise.reject(new Error("engine died"))
        : Promise.resolve({ playbackUrl: `${baseUrl}/play`, statUrl: `${baseUrl}/stat`, commandUrl: `${baseUrl}/cmd` });
    },
    stopSession: (commandUrl: string) => {
      stopped.push(commandUrl);
      return Promise.resolve();
    },
    stats: () =>
      fakes.sessionsForgotten?.on === true
        ? Promise.reject(new Error("unknown playback session"))
        : Promise.resolve({ status: "dl", peers: 1, speedDown: 0, speedUp: 0, downloaded: 0, uploaded: 0 }),
  } as unknown as AcestreamClient;
  // The source a path move asked the transcoder to cut over to, and the one it plays from.
  let pending: string | undefined;
  let active = pipeline.source;
  // The sources of every handover the transcoder was asked for.
  const handovers: string[] = [];
  const real = {
    active: undefined as string | undefined,
    pending: undefined as string | undefined,
    since: 0,
    lastFrameAt: null as string | null,
  };
  /** The playback URLs that deliver now. */
  const delivering = (): Set<string> => {
    const sources = fakes.sources ?? new Set();
    const arrivals = fakes.arrives ?? new Map<string, number>();
    for (const [url, at] of arrivals) {
      if (clock.now >= at) {
        sources.add(url);
      }
    }
    return sources;
  };
  // The sources the standby readers were told to read, on each check.
  const readers: string[][] = [];
  const realStatus = (): PipelineStatus | undefined => {
    const sources = delivering();
    if (real.pending !== undefined && sources.has(real.pending)) {
      real.active = real.pending;
      real.pending = undefined;
    } else if (real.pending !== undefined && clock.now - real.since > settings.handoverTimeoutMs) {
      real.pending = undefined;
    }
    if (real.active === undefined) {
      return undefined;
    }
    const exitsAt = fakes.exits?.get(real.active);
    const state = exitsAt !== undefined && clock.now >= exitsAt ? "exited" : "running";
    if (state === "running" && sources.has(real.active)) {
      real.lastFrameAt = new Date(clock.now).toISOString();
    }
    const source = real.active;
    return { ...pipeline, state, source, pendingSource: real.pending ?? null, lastFrameAt: real.lastFrameAt };
  };
  const transcoder = {
    start: (_id: string, input: { source: string }, handover?: boolean) => {
      pending = handover === true ? input.source : undefined;
      if (handover === true) {
        handovers.push(input.source);
      }
      if (handover !== true) {
        active = input.source;
      }
      if (fakes.sources !== undefined) {
        fakes.exits?.delete(input.source);
        const keep = handover === true && real.active !== undefined && fakes.sources.has(real.active);
        if (keep) {
          real.pending = input.source;
          real.since = clock.now;
        } else {
          real.active = input.source;
          real.pending = undefined;
          real.lastFrameAt = null;
        }
        return Promise.resolve(realStatus());
      }
      return Promise.resolve(pipeline);
    },
    status: () => {
      if (fakes.sources !== undefined) {
        return Promise.resolve(realStatus());
      }
      const handover = typeof fakes.handover === "object" ? fakes.handover.value : fakes.handover;
      const delivers = fakes.video?.on === true || (pending !== undefined && handover === "delivers");
      const source = pending ?? active;
      if (!delivers) {
        // A handover that brings no video fails, and the transcoder drops it.
        pending = undefined;
      }
      return Promise.resolve(
        delivers ? { ...pipeline, source, lastFrameAt: new Date(clock.now).toISOString() } : { ...pipeline, source },
      );
    },
    stop: () => Promise.resolve(),
    setStandbys: (_id: string, sources: string[]) => {
      readers.push(sources);
      if (fakes.sources === undefined || real.active === undefined) {
        return Promise.resolve(undefined);
      }
      const data = fakes.standbyData ?? delivering();
      return Promise.resolve(
        sources.map((source) => ({
          source,
          state: data.has(source) ? "receiving" : "connecting",
          bytes: 0,
          lastDataAt: data.has(source) ? new Date(clock.now).toISOString() : null,
          error: null,
        })),
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
  const updates: Record<string, unknown>[] = [];
  let saved: StreamConfig = fakes.ownEngine === undefined ? stream : { ...stream, ownEngine: fakes.ownEngine };
  const store = {
    get: () => saved,
    update: (_id: string, patch: Partial<StreamConfig>) => {
      updates.push(patch);
      saved = { ...saved, ...patch };
      return Promise.resolve(saved);
    },
  } as unknown as StreamStore;
  const metrics = new ControllerMetrics(new Registry(), () => ({ streams: [], paths: [] }));
  const instance = new StreamSupervisor(saved, {
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
    ...(fakes.spareSlots !== undefined && { spareSlots: fakes.spareSlots }),
    ...(fakes.shared !== undefined && { shared: fakes.shared }),
    ...(fakes.standbyStarts !== undefined && { standbyStarts: fakes.standbyStarts }),
    sharedEngines: () => fakes.sharing?.on === true,
    hotStandby: () => fakes.hotStandby?.on === true,
    standby: { ...DEFAULT_STANDBY_SETTINGS, ...fakes.standby },
    viewers: () => fakes.viewers ?? 0,
    pathLoad: () => new Map(),
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  return {
    instance,
    assigned,
    assignedWhenReady,
    unassigned,
    removed,
    restarted,
    revived,
    clock,
    stopped,
    handovers,
    sessions: () => sessions,
    creates: () => creates,
    readers,
    updates,
    real,
  };
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

describe("taking over engines after a controller restart", () => {
  const newer: EngineHandle = { ...engine, containerId: "c2", name: "aceswarm-engine-s1-2", generation: 2 };

  test("takes over the engine the stream played from, not a newer one a failed move left", async () => {
    const fake = supervisor([direct], { found: [newer, engine], ownEngine: engine.name });
    await fake.instance.tick();
    expect(fake.revived).toEqual([engine.containerId]);
    expect(fake.removed).toEqual([newer.containerId]);
    expect(fake.instance.view().engine?.name).toBe(engine.name);
  });

  test("takes over the newest engine when it doesn't know which one the stream played from", async () => {
    const fake = supervisor([direct], { found: [newer, engine] });
    await fake.instance.tick();
    expect(fake.revived).toEqual([newer.containerId]);
    expect(fake.removed).toEqual([engine.containerId]);
    expect(fake.updates).toContainEqual({ ownEngine: newer.name });
  });
});

describe("moving a stream to another path", () => {
  const vpn: PathStatus = { ...direct, id: "wg:a", kind: "wireguard", label: "VPN", score: 0.5 };
  const replacement: EngineHandle = {
    ...engine,
    containerId: "c2",
    name: "aceswarm-engine-s1-2",
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
    return { ...fake, paths };
  }

  /** Ticks until the stream tried to move `count` times in all. */
  async function untilMoves(fake: Awaited<ReturnType<typeof moveOffDirect>>, count: number) {
    for (let tick = 0; tick < 100 && fake.handovers.length < count; tick += 1) {
      fake.clock.now += 10_000;
      await fake.instance.tick();
    }
    expect(fake.handovers).toHaveLength(count);
  }

  test("keeps the engine it started when the new path brings no video, and tries again on it", async () => {
    const video = { on: false };
    const fake = await moveOffDirect({ handover: "stops", video });
    const { instance, assigned, assignedWhenReady, removed, handovers } = fake;
    expect(assigned.at(-1)).toEqual({ ip: replacement.ip, path: "wg:a" });
    expect(removed).toEqual([]);
    // The kept engine stays on its path, so it keeps its peers.
    expect(instance.assignments()).toEqual([
      { ip: engine.ip, path: "direct" },
      { ip: replacement.ip, path: "wg:a" },
    ]);
    expect(instance.path).toBe("direct");
    expect(handovers).toEqual([`${replacement.baseUrl}/play`]);

    await untilMoves(fake, 2);
    // No new engine: the same one, and the session it opened there, which the engine still knows.
    expect(assignedWhenReady).toHaveLength(2);
    expect(fake.revived).toEqual([replacement.containerId]);
    expect(fake.sessions()).toBe(2);
    expect(handovers).toEqual([`${replacement.baseUrl}/play`, `${replacement.baseUrl}/play`]);
    expect(removed).toEqual([]);
  });

  test("moves to the kept engine once it delivers, and remembers it", async () => {
    const handover: { value: "delivers" | "stops" } = { value: "stops" };
    const fake = await moveOffDirect({ handover, video: { on: false } });
    handover.value = "delivers";
    await untilMoves(fake, 2);
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view().engine?.name).toBe(replacement.name);
    expect(fake.removed).toEqual([engine.containerId]);
    expect(fake.instance.assignments()).toEqual([{ ip: replacement.ip, path: "wg:a" }]);
    expect(fake.updates).toContainEqual({ ownEngine: replacement.name });
    expect(fake.assignedWhenReady).toHaveLength(2);
  });

  test("removes the kept engine after its third failed move, and the next try starts a new one", async () => {
    const third: EngineHandle = { ...replacement, containerId: "c3", ip: "172.31.250.12", baseUrl: "http://third:1" };
    const fake = await moveOffDirect({
      handover: "stops",
      video: { on: false },
      created: [engine, replacement, third],
    });
    await untilMoves(fake, 3);
    expect(fake.removed).toEqual([replacement.containerId]);
    expect(fake.unassigned).toEqual([replacement.ip]);
    expect(fake.instance.assignments()).toEqual([{ ip: engine.ip, path: "direct" }]);

    await untilMoves(fake, 4);
    expect(fake.assignedWhenReady).toHaveLength(3);
    expect(fake.handovers.at(-1)).toBe(`${third.baseUrl}/play`);
  });

  test("opens a new session on the kept engine when the engine no longer knows the old one", async () => {
    const sessionsForgotten = { on: true };
    const fake = await moveOffDirect({ handover: "stops", video: { on: false }, sessionsForgotten });
    await untilMoves(fake, 2);
    expect(fake.sessions()).toBe(3);
    expect(fake.stopped).toContain(`${replacement.baseUrl}/cmd`);
    expect(fake.assignedWhenReady).toHaveLength(2);
  });

  test("starts a new engine when the kept one is gone", async () => {
    const third: EngineHandle = { ...replacement, containerId: "c3", ip: "172.31.250.12", baseUrl: "http://third:1" };
    const gone = new Set([replacement.containerId]);
    const fake = await moveOffDirect({
      handover: "stops",
      video: { on: false },
      created: [engine, replacement, third],
      gone,
    });
    await untilMoves(fake, 2);
    expect(fake.removed).toEqual([replacement.containerId]);
    expect(fake.assignedWhenReady).toHaveLength(3);
    expect(fake.handovers.at(-1)).toBe(`${third.baseUrl}/play`);
  });

  test("an engine restart in place keeps the kept engine's path", async () => {
    const fake = await moveOffDirect({ handover: "stops", video: { on: false } });
    // The direct path is back: no path move, so the ladder restarts the engine in place.
    fake.paths[0] = direct;
    for (let tick = 0; tick < 100 && fake.restarted.length === 0; tick += 1) {
      fake.clock.now += 10_000;
      await fake.instance.tick();
    }
    expect(fake.restarted).toEqual([engine.containerId]);
    expect(fake.instance.assignments()).toContainEqual({ ip: replacement.ip, path: "wg:a" });
  });

  test("removes the engine it started, as before, while every slot for kept engines is taken", async () => {
    const fake = await moveOffDirect({ handover: "stops", video: { on: false }, spareSlots: new MoveSlots(0) });
    expect(fake.removed).toEqual([replacement.containerId]);
    expect(fake.instance.assignments()).toEqual([{ ip: engine.ip, path: "direct" }]);
  });

  test("a kept engine holds its slot until it goes", async () => {
    const spareSlots = new MoveSlots(1);
    const video = { on: false };
    const fake = await moveOffDirect({ handover: "stops", video, spareSlots });
    await untilMoves(fake, 2);
    // Trying it again needs no second slot.
    expect(fake.removed).toEqual([]);
    expect(spareSlots.tryTake()).toBe(false);

    video.on = true;
    await fake.instance.tick();
    expect(fake.removed).toEqual([replacement.containerId]);
    expect(spareSlots.tryTake()).toBe(true);
  });

  test("moves to the kept engine once its video arrives after the move gave up", async () => {
    // The direct path dies, so its engine delivers nothing and the old ffmpeg has exited: with no
    // picture to keep, the new engine becomes the transcoder's only source, and it goes on reading it.
    const spareSlots = new MoveSlots(1);
    const sources = new Set([`${engine.baseUrl}/play`]);
    const paths = [direct, vpn];
    const fake = supervisor(paths, { created: [engine, replacement], sources, spareSlots });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    paths[0] = { ...direct, up: false };
    sources.clear();
    fake.clock.now += settings.stallAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.handovers).toEqual([`${replacement.baseUrl}/play`]);
    expect(fake.real.active).toBe(`${replacement.baseUrl}/play`);
    expect(fake.instance.path).toBe("direct");
    expect(fake.removed).toEqual([]);

    // Its first video comes a little later.
    sources.add(`${replacement.baseUrl}/play`);
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view().engine?.name).toBe(replacement.name);
    expect(fake.removed).toEqual([engine.containerId]);
    expect(fake.instance.assignments()).toEqual([{ ip: replacement.ip, path: "wg:a" }]);
    expect(fake.updates).toContainEqual({ ownEngine: replacement.name });
    expect(fake.stopped).toContain(`${engine.baseUrl}/cmd`);
    expect(spareSlots.tryTake()).toBe(true);
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    expect(fake.removed).toEqual([engine.containerId]);
  });

  test("keeps the kept engine when taking it over fails for a moment", async () => {
    const reviveFails = { on: true };
    const fake = await moveOffDirect({ handover: "stops", video: { on: false }, reviveFails });
    for (let tick = 0; tick < 100 && fake.revived.length === 0; tick += 1) {
      fake.clock.now += 10_000;
      await fake.instance.tick();
    }
    expect(fake.revived).toEqual([replacement.containerId]);
    expect(fake.removed).toEqual([]);
    expect(fake.instance.assignments()).toContainEqual({ ip: replacement.ip, path: "wg:a" });

    reviveFails.on = false;
    await untilMoves(fake, 2);
    expect(fake.assignedWhenReady).toHaveLength(2);
    expect(fake.handovers.at(-1)).toBe(`${replacement.baseUrl}/play`);
  });

  test("removes the kept engine once taking it over failed again and again", async () => {
    const reviveFails = { on: true };
    const fake = await moveOffDirect({ handover: "stops", video: { on: false }, reviveFails });
    for (let tick = 0; tick < 100 && !fake.removed.includes(replacement.containerId); tick += 1) {
      fake.clock.now += 10_000;
      await fake.instance.tick();
    }
    // The failed move and two Docker errors.
    expect(fake.revived.filter((id) => id === replacement.containerId)).toHaveLength(2);
    expect(fake.removed).toContain(replacement.containerId);
  });

  test("follows the kept engine to its new address when it came back on one", async () => {
    const moved: EngineHandle = { ...replacement, ip: "172.31.250.13", baseUrl: "http://172.31.250.13:6878" };
    const fake = await moveOffDirect({
      handover: "stops",
      video: { on: false },
      reviveAs: new Map([[replacement.containerId, moved]]),
    });
    await untilMoves(fake, 2);
    expect(fake.unassigned).toContain(replacement.ip);
    expect(fake.instance.assignments()).toEqual([
      { ip: engine.ip, path: "direct" },
      { ip: moved.ip, path: "wg:a" },
    ]);
    // The old session's address is gone with it, so the move opened a new session there.
    expect(fake.handovers.at(-1)).toBe(`${moved.baseUrl}/play`);
  });

  test("removes the kept engine when the next move goes to another path", async () => {
    const other: PathStatus = { ...vpn, id: "wg:b", label: "VPN 2", score: 0.4 };
    const third: EngineHandle = { ...replacement, containerId: "c3", ip: "172.31.250.12", baseUrl: "http://third:1" };
    const paths = [direct, vpn, other];
    const fake = supervisor(paths, {
      created: [engine, replacement, third],
      handover: "stops",
      video: { on: false },
    });
    await fake.instance.tick();
    paths[0] = { ...direct, up: false };
    fake.clock.now += settings.startupGraceMs + 1000;
    await fake.instance.tick();
    expect(fake.handovers).toEqual([`${replacement.baseUrl}/play`]);

    paths[1] = { ...vpn, up: false };
    for (let tick = 0; tick < 100 && fake.handovers.length < 2; tick += 1) {
      fake.clock.now += 10_000;
      await fake.instance.tick();
    }
    expect(fake.handovers.at(-1)).toBe(`${third.baseUrl}/play`);
    expect(fake.removed).toEqual([replacement.containerId]);
    expect(fake.instance.assignments()).toEqual([
      { ip: engine.ip, path: "direct" },
      { ip: third.ip, path: "wg:b" },
    ]);
  });

  test("frees the kept engine's slot when the stream is removed", async () => {
    const spareSlots = new MoveSlots(1);
    const fake = await moveOffDirect({ handover: "stops", video: { on: false }, spareSlots });
    expect(spareSlots.tryTake()).toBe(false);
    await fake.instance.stop(true);
    expect(spareSlots.tryTake()).toBe(true);
    expect(fake.instance.assignments()).toEqual([]);
  });

  test("removes the kept engine once the stream plays again on its own", async () => {
    const video = { on: false };
    const fake = await moveOffDirect({ handover: "stops", video });
    video.on = true;
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    expect(fake.removed).toEqual([replacement.containerId]);
    expect(fake.instance.assignments()).toEqual([{ ip: engine.ip, path: "direct" }]);
  });

  test("removes the kept engine once no move tried it again for a while", async () => {
    const paths = [direct, vpn];
    const fake = supervisor(paths, { created: [engine, replacement], handover: "stops", video: { on: false } });
    await fake.instance.tick();
    paths[0] = { ...direct, up: false };
    fake.clock.now += settings.startupGraceMs + 1000;
    await fake.instance.tick();
    expect(fake.removed).toEqual([]);
    // The tunnel goes down too, so nothing moves to it any more.
    paths[1] = { ...vpn, up: false };
    fake.clock.now += 2 * settings.recoveryMaxDelayMs;
    await fake.instance.tick();
    expect(fake.removed).toEqual([replacement.containerId]);
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
    name: "aceswarm-engine-s1-2",
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
    const { instance, assignedWhenReady, clock, handovers, revived } = supervisor([direct, vpn], {
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

    // The next tick doesn't try again yet.
    await instance.tick();
    expect(handovers).toHaveLength(1);
    expect(instance.view().message).toMatch(/path direct is off; moving again in \d+s/);

    // It tries again on the engine it started, which stayed on its path meanwhile.
    clock.now += settings.recoveryMaxDelayMs;
    await instance.tick();
    expect(handovers).toHaveLength(2);
    expect(assignedWhenReady).toHaveLength(2);
    expect(revived).toEqual([replacement.containerId]);
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

  /** A playing stream whose direct engine stops just as WireGuard only goes on; the move fails. */
  async function lostDirect(fakes: Fakes = {}) {
    const { state, pathAllowed } = policy(false);
    const sources = new Set([`${engine.baseUrl}/play`]);
    const fake = supervisor([direct, vpn], { created: [engine, replacement], sources, pathAllowed, ...fakes });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    state.on = true;
    // Its ffmpeg has exited, so there is no picture to keep: the new engine is the only source.
    sources.clear();
    await fake.instance.tick();
    expect(fake.instance.path).toBe("direct");
    expect(fake.real.active).toBe(`${replacement.baseUrl}/play`);
    return { ...fake, sources };
  }

  test("moves to the kept engine once its late video arrives, while it waits for a slot", async () => {
    const policyMoves = new MoveSlots(1);
    const fake = await lostDirect({ policyMoves });
    // Other streams are moving when it could try again.
    expect(policyMoves.tryTake()).toBe(true);
    fake.clock.now += settings.recoveryMaxDelayMs;
    await fake.instance.tick();
    expect(fake.instance.view().message).toBe("path direct is off; other streams move first");

    fake.sources.add(`${replacement.baseUrl}/play`);
    fake.clock.now += 10_000;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view().engine?.name).toBe(replacement.name);
    expect(fake.removed).toEqual([engine.containerId]);
    expect(fake.handovers).toEqual([`${replacement.baseUrl}/play`]);
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
  });

  test("trying the kept engine again doesn't open a second reader the transcoder would start", async () => {
    const arrives = new Map<string, number>();
    const fake = await lostDirect({ arrives });
    // One on each engine.
    expect(fake.sessions()).toBe(2);
    fake.clock.now += settings.recoveryMaxDelayMs;
    // Its video comes while the next move waits for it.
    arrives.set(`${replacement.baseUrl}/play`, fake.clock.now + 30_000);
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.revived).toEqual([replacement.containerId]);
    // The transcoder already read the kept session, so the move only waited for it.
    expect(fake.handovers).toEqual([`${replacement.baseUrl}/play`]);
    expect(fake.sessions()).toBe(2);
    expect(fake.removed).toEqual([engine.containerId]);
  });

  test("starts a reader of its own on the kept engine when the one it waited for gives up", async () => {
    const arrives = new Map<string, number>();
    const exits = new Map<string, number>();
    const fake = await lostDirect({ arrives, exits });
    fake.clock.now += settings.recoveryMaxDelayMs;
    // The first move's ffmpeg is still reading the kept session, but not for long.
    exits.set(`${replacement.baseUrl}/play`, fake.clock.now + 5000);
    arrives.set(`${replacement.baseUrl}/play`, fake.clock.now + 30_000);
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.handovers).toEqual([`${replacement.baseUrl}/play`, `${replacement.baseUrl}/play`]);
    expect(fake.sessions()).toBe(2);
    expect(fake.removed).toEqual([engine.containerId]);
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

  test("keeps the engine of its own it started while sharing is off and its move failed", async () => {
    const pool = sharedEngines();
    const sharing = { on: true };
    const video = { on: true };
    const handover: { value: "delivers" | "stops" } = { value: "stops" };
    const fake = supervisor([direct], { shared: pool.shared, sharing, video, handover });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");

    // Sharing is turned off, but the new engine brings no video in time.
    sharing.on = false;
    video.on = false;
    await fake.instance.tick();
    expect(fake.handovers).toEqual([`${engine.baseUrl}/play`]);
    expect(fake.instance.view().engine?.shared).toBe(true);
    expect(fake.removed).toEqual([]);
    expect(fake.instance.assignments()).toEqual([{ ip: engine.ip, path: "direct" }]);

    // It still plays from the shared engine meanwhile, which doesn't make it give up the new one.
    video.on = true;
    await fake.instance.tick();
    expect(fake.removed).toEqual([]);

    // The next try goes to the same engine, which delivers this time.
    handover.value = "delivers";
    video.on = false;
    fake.clock.now += settings.recoveryMaxDelayMs;
    await fake.instance.tick();
    expect(fake.handovers).toEqual([`${engine.baseUrl}/play`, `${engine.baseUrl}/play`]);
    expect(fake.revived).toEqual([engine.containerId]);
    expect(fake.instance.view().engine).toEqual({ name: engine.name, shared: false });
    expect(pool.released).toEqual([sharedEngine.containerId]);
  });

  test("removes the engine of its own it kept once sharing is turned on again", async () => {
    const pool = sharedEngines();
    const sharing = { on: true };
    const video = { on: true };
    const fake = supervisor([direct], { shared: pool.shared, sharing, video, handover: "stops" });
    await fake.instance.tick();
    await fake.instance.tick();
    sharing.on = false;
    video.on = false;
    await fake.instance.tick();
    expect(fake.removed).toEqual([]);

    sharing.on = true;
    video.on = true;
    await fake.instance.tick();
    expect(fake.removed).toEqual([engine.containerId]);
    expect(fake.instance.assignments()).toEqual([]);
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

  test("a failed move to the shared engine stops the session it opened there", async () => {
    const pool = sharedEngines();
    const sharing = { on: false };
    const video = { on: true };
    const fake = supervisor([direct], { shared: pool.shared, sharing, video, handover: "stops" });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    // Sharing is turned on, but the shared engine brings no video in time.
    sharing.on = true;
    video.on = false;
    await fake.instance.tick();
    expect(fake.instance.view().engine).toEqual({ name: engine.name, shared: false });
    expect(pool.released).toEqual([sharedEngine.containerId]);
    // The engine stays for other streams; the session nobody reads doesn't.
    expect(fake.stopped).toEqual([`${sharedEngine.baseUrl}/cmd`]);
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

/** The stream's own engine of this generation. */
function own(generation: number): EngineHandle {
  const ip = `172.31.250.${String(9 + generation)}`;
  const name = `aceswarm-engine-s1-${String(generation)}`;
  return { ...engine, containerId: `c${String(generation)}`, name, generation, ip, baseUrl: `http://${ip}:6878` };
}
const main = own(1);
const standbyEngine = own(2);
const play = (handle: EngineHandle): string => `${handle.baseUrl}/play`;

/** Lets the standbys' background work finish. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await setImmediate();
  }
}

/** The engine shared by the streams on `path`. */
function sharedOn(path: string, id: number): EngineHandle {
  const ip = `172.31.250.${String(id)}`;
  const name = `aceswarm-engine-shared-${path}-1`;
  return {
    ...engine,
    containerId: `shared-${path}`,
    name,
    streamId: "",
    ip,
    baseUrl: `http://${ip}:6878`,
    sharedPath: path,
  };
}

describe("hot standby on the other paths", () => {
  const vpn: PathStatus = { ...direct, id: "wg:a", kind: "wireguard", label: "VPN", score: 0.5 };
  const vpnB: PathStatus = { ...direct, id: "wg:b", kind: "wireguard", label: "VPN B", score: 0.4 };

  /** A stream playing on the direct path, with a standby on the VPN whose reader got data (unless `standbyData` says otherwise). */
  async function withStandby(fakes: Fakes = {}, paths: PathStatus[] = [direct, vpn]) {
    const sources = new Set([play(main), play(standbyEngine)]);
    const fake = supervisor(paths, {
      created: [main, standbyEngine, own(3), own(4)],
      sources,
      hotStandby: { on: true },
      ...fakes,
    });
    // Starts the engine and the stream; video arrives on the next check.
    await fake.instance.tick();
    await fake.instance.tick();
    // Standbys only start once the stream played.
    expect(fake.instance.view().standbys).toEqual([]);
    await fake.instance.tick();
    await settle();
    await fake.instance.tick();
    return { ...fake, paths, sources };
  }

  test("keeps a hot standby on the other path once the stream plays", async () => {
    const fake = await withStandby();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
    expect(fake.instance.view().standbys).toEqual([
      { path: "wg:a", state: "hot", engine: { name: standbyEngine.name, shared: false } },
    ]);
    expect(fake.instance.assignments()).toEqual([
      { ip: main.ip, path: "direct" },
      { ip: standbyEngine.ip, path: "wg:a" },
    ]);
    // The transcoder reads the standby session, so the engine keeps pulling the stream.
    expect(fake.readers.at(-1)).toEqual([play(standbyEngine)]);
  });

  test("fails over to the hot standby soon after video stops, without starting an engine", async () => {
    const fake = await withStandby();
    fake.sources.delete(play(main));
    fake.clock.now += DEFAULT_STANDBY_SETTINGS.failoverAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view()).toMatchObject({ engine: { name: standbyEngine.name, shared: false }, recoveries: 1 });
    expect(fake.real.active).toBe(play(standbyEngine));
    expect(fake.creates()).toBe(2);
    expect(fake.removed).toEqual([]);
    expect(fake.restarted).toEqual([]);
    expect(fake.stopped).toEqual([`${main.baseUrl}/cmd`]);
    // The engine it left becomes the standby on its path.
    expect(fake.instance.view().standbys).toMatchObject([{ path: "direct", engine: { name: main.name } }]);
    expect(fake.instance.assignments()).toEqual([
      { ip: standbyEngine.ip, path: "wg:a" },
      { ip: main.ip, path: "direct" },
    ]);

    await fake.instance.tick();
    await settle();
    expect(fake.instance.view().state).toBe("playing");
    // It opened a new session there, which the transcoder reads.
    await fake.instance.tick();
    expect(fake.readers.at(-1)).toEqual([play(main)]);
  });

  test("fails over to the hot standby before any other recovery step", async () => {
    const fake = await withStandby({ standby: { failoverAfterMs: 3_600_000 } });
    fake.sources.delete(play(main));
    fake.clock.now += settings.stallAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view().recoveries).toBe(1);
    expect(fake.restarted).toEqual([]);
    expect(fake.handovers).toEqual([play(standbyEngine)]);
  });

  test("a failover that brings no video leaves the stream where it was, and the ladder goes on", async () => {
    const standbyData = new Set([play(standbyEngine)]);
    const policy = { baseDelayMs: 600_000, maxDelayMs: 600_000 };
    const fake = await withStandby({ standbyData, standby: { policy } });
    fake.sources.delete(play(main));
    fake.sources.delete(play(standbyEngine));
    fake.clock.now += DEFAULT_STANDBY_SETTINGS.failoverAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("direct");
    expect(fake.instance.view()).toMatchObject({ state: "stalled", engine: { name: main.name } });
    expect(fake.instance.view().message).toMatch(/^failing over to wg:a failed/);
    // The standby stays, but no failover tries it again for a while.
    expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a" }]);
    fake.clock.now += settings.startupGraceMs;
    await fake.instance.tick();
    expect(fake.handovers).toEqual([play(standbyEngine)]);
    expect(fake.instance.view()).toMatchObject({ state: "recovering", path: "direct" });
    expect(fake.real.active).toBe(play(main));
  });

  test("a path switch moves to the standby on the new path, even before it is hot", async () => {
    const fake = await withStandby({ standbyData: new Set() });
    expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a", state: "warming" }]);
    fake.sources.delete(play(main));
    fake.paths[0] = { ...direct, up: false };
    fake.clock.now += settings.stallAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.creates()).toBe(2);
    expect(fake.instance.view().engine?.name).toBe(standbyEngine.name);

    // The engine it left stays as the standby on its path for a while, in case the path comes back.
    await fake.instance.tick();
    await settle();
    expect(fake.instance.view().standbys).toMatchObject([{ path: "direct", engine: { name: main.name } }]);
    expect(fake.removed).toEqual([]);
    fake.clock.now += DEFAULT_STANDBY_SETTINGS.downGraceMs + 1000;
    await fake.instance.tick();
    await settle();
    expect(fake.removed).toEqual([main.containerId]);
    expect(fake.instance.view().standbys).toEqual([]);
  });

  test("starts a standby that brings no data again, and removes it after its third try", async () => {
    const fake = await withStandby({ standbyData: new Set() });
    for (let tick = 0; tick < 200 && fake.removed.length === 0; tick += 1) {
      fake.clock.now += 5000;
      await fake.instance.tick();
      await settle();
    }
    expect(fake.restarted).toEqual([standbyEngine.containerId, standbyEngine.containerId]);
    expect(fake.removed).toEqual([standbyEngine.containerId]);
    expect(fake.instance.view().standbys).toEqual([]);
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
  });

  test("removes the standbys once hot standby is turned off", async () => {
    const hotStandby = { on: true };
    const fake = await withStandby({ hotStandby });
    hotStandby.on = false;
    await fake.instance.tick();
    await settle();
    expect(fake.removed).toEqual([standbyEngine.containerId]);
    expect(fake.unassigned).toEqual([standbyEngine.ip]);
    expect(fake.instance.view().standbys).toEqual([]);
    expect(fake.instance.assignments()).toEqual([{ ip: main.ip, path: "direct" }]);
    expect(fake.readers.at(-1)).toEqual([]);
  });

  test("keeps a standby on every other path, or on the best few", async () => {
    const all = await withStandby({}, [direct, vpn, vpnB]);
    // One starts per check.
    await all.instance.tick();
    await settle();
    expect(all.instance.view().standbys.map((standby) => standby.path)).toEqual(["wg:a", "wg:b"]);

    const best = await withStandby({ standby: { maxPaths: 1 } }, [direct, vpn, vpnB]);
    await best.instance.tick();
    await settle();
    expect(best.instance.view().standbys.map((standby) => standby.path)).toEqual(["wg:a"]);
  });

  test("starts no standby on a path the policy turned off", async () => {
    const fake = await withStandby({ pathAllowed: (path) => path !== "wg:a" }, [direct, vpn, vpnB]);
    await fake.instance.tick();
    await settle();
    expect(fake.instance.view().standbys.map((standby) => standby.path)).toEqual(["wg:b"]);
  });

  test("removes the standbys when the stream stops", async () => {
    const fake = await withStandby();
    await fake.instance.stop(true);
    expect(fake.removed).toContain(standbyEngine.containerId);
    expect(fake.readers.at(-1)).toEqual([]);
  });

  describe("with engines shared per path", () => {
    const onDirect = sharedOn("direct", 20);
    const onVpn = sharedOn("wg:a", 21);

    function sharedEngines() {
      const byPath = new Map([
        ["direct", onDirect],
        ["wg:a", onVpn],
      ]);
      const calls: string[] = [];
      const shared = {
        acquire: (path: string, _stream: string, role = "play") => {
          calls.push(`acquire ${path} as ${role}`);
          return Promise.resolve(byPath.get(path));
        },
        rejoin: (handle: EngineHandle) => Promise.resolve(handle),
        release: (handle: EngineHandle) => {
          calls.push(`release ${handle.sharedPath ?? "?"}`);
          return Promise.resolve();
        },
        releaseStandby: (handle: EngineHandle) => {
          calls.push(`release standby on ${handle.sharedPath ?? "?"}`);
          return Promise.resolve();
        },
        promote: (handle: EngineHandle) => {
          calls.push(`promote ${handle.sharedPath ?? "?"}`);
          return true;
        },
        isCurrent: () => true,
        reportFailure: () => false,
        restart: () => true,
      } as unknown as SharedEngines;
      return { shared, calls };
    }

    test("keeps a standby session on the other path's shared engine, and fails over to it", async () => {
      const pool = sharedEngines();
      const sources = new Set([play(onDirect), play(onVpn)]);
      const fake = await withStandby({ shared: pool.shared, sharing: { on: true }, sources });
      expect(pool.calls).toEqual(["acquire direct as play", "acquire wg:a as standby"]);
      expect(fake.instance.view().standbys).toEqual([
        { path: "wg:a", state: "hot", engine: { name: onVpn.name, shared: true } },
      ]);
      // The shared engines manage their gateway paths.
      expect(fake.instance.assignments()).toEqual([]);

      sources.delete(play(onDirect));
      fake.clock.now += settings.stallAfterMs + 1000;
      await fake.instance.tick();
      expect(fake.instance.path).toBe("wg:a");
      expect(fake.instance.view().engine).toEqual({ name: onVpn.name, shared: true });
      expect(fake.creates()).toBe(0);
      expect(pool.calls.slice(2)).toEqual(["promote wg:a", "release direct"]);

      // The path it left gets a standby session on its shared engine.
      await fake.instance.tick();
      await settle();
      expect(pool.calls.at(-1)).toBe("acquire direct as standby");
    });

    test("replaces the standbys of its own with sessions on shared engines once sharing is on", async () => {
      const pool = sharedEngines();
      const sharing = { on: false };
      const sources = new Set([play(main), play(standbyEngine), play(onDirect), play(onVpn)]);
      const fake = await withStandby({ shared: pool.shared, sharing, sources });
      sharing.on = true;
      for (let tick = 0; tick < 10; tick += 1) {
        fake.clock.now += 1000;
        await fake.instance.tick();
        await settle();
      }
      expect(fake.instance.view().engine).toEqual({ name: onDirect.name, shared: true });
      expect(fake.removed).toEqual(expect.arrayContaining([main.containerId, standbyEngine.containerId]));
      expect(fake.instance.view().standbys).toEqual([
        { path: "wg:a", state: "hot", engine: { name: onVpn.name, shared: true } },
      ]);
      expect(fake.instance.assignments()).toEqual([]);
    });
  });
});
