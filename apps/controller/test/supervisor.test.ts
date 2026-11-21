import { setImmediate } from "node:timers/promises";
import { Registry } from "@prometheus-io/client";
import type {
  LiveEdgeView,
  PathAssignment,
  PathStatus,
  PipelineStatus,
  StandbyReaderStatus,
  StandbySource,
} from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AcestreamClient, EngineSession } from "../src/acestream.ts";
import type { NetgwClient, TranscoderClient } from "../src/clients.ts";
import { EngineGoneError, type EngineHandle, type EngineManager, type OnEngineAddress } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import type { FailureReport, SharedEngines } from "../src/shared-engines.ts";
import { DEFAULT_STANDBY_SETTINGS, StreamStandbys, type StandbySettings } from "../src/standby.ts";
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
  liveEdge: null,
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
  session: null,
  lastFrameAt: null,
};

interface Fakes {
  /** Engines handed out by `create`, in order (the last one repeats). */
  created?: EngineHandle[];
  /** Fails the first session start, like an engine that dies right away. */
  failFirstSession?: boolean;
  /** While on, no session opens. */
  failSessions?: { on: boolean };
  /** Gives each session URLs of its own, as a real engine does (by default an engine's sessions share them). */
  sessionIds?: boolean;
  /** Starting the transcoder fails this many more times. */
  transcoderStartFails?: { left: number };
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
  /** The session the stream played from before the controller restarted. */
  savedSession?: EngineSession;
  /** While on, opening a session never finishes. */
  hangSessions?: boolean;
  /** Opening a session waits until this promise settles. */
  sessionGate?: Promise<void>;
  /** While on, starting an engine fails the way a Docker API error does. */
  failEngineStarts?: { on: boolean };
  /** While on, the stream keeps hot standbys on the other paths (off by default). */
  hotStandby?: { on: boolean };
  standby?: Partial<StandbySettings>;
  /** Slots shared by every stream's starting standbys. */
  standbyStarts?: MoveSlots;
  /** The playback URLs whose standby readers get data (`sources` by default). */
  standbyData?: Set<string>;
  /** What the standby readers that get no data report as their error (none by default). */
  standbyError?: { value: string | null };
  /** While on, the standby readers report their broadcast's live edge as stale. */
  standbyStale?: { on: boolean };
  /** While on, the transcoder can't be reached. */
  transcoderDown?: { on: boolean };
  /** When the stream last had video in an earlier run. */
  lastFrameAt?: string;
  /** The live edge the transcoder reports for the source it reads (none by default). */
  liveEdge?: { value: LiveEdgeView | null };
  /** Requests that wait while the test holds them (see `Hold`). */
  hold?: Hold;
  /** The number of peers an engine session's stats report, by its stat URL (1 by default). */
  peersOf?: (statUrl: string) => number;
}

/** What the fakes hold up until a test lets them go, to keep a supervision step waiting. */
interface Hold {
  /** Opening a session waits for this, and fails when it rejects. */
  session?: Promise<unknown> | undefined;
  /** A stats request waits for the promise of its stat URL. */
  stats?: Map<string, Promise<unknown>>;
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
      if (fakes.failEngineStarts?.on === true) {
        throw new Error("docker said no");
      }
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
    startSession: async (baseUrl: string) => {
      if (fakes.hangSessions === true) {
        return new Promise(() => undefined);
      }
      await fakes.sessionGate;
      await fakes.hold?.session;
      sessions += 1;
      if ((fakes.failFirstSession === true && sessions === 1) || fakes.failSessions?.on === true) {
        throw new Error("engine died");
      }
      const id = fakes.sessionIds === true ? `?session=${String(sessions)}` : "";
      return {
        playbackUrl: `${baseUrl}/play${id}`,
        statUrl: `${baseUrl}/stat${id}`,
        commandUrl: `${baseUrl}/cmd${id}`,
      };
    },
    stopSession: (commandUrl: string) => {
      stopped.push(commandUrl);
      return Promise.resolve();
    },
    stats: async (statUrl: string) => {
      await fakes.hold?.stats?.get(statUrl);
      if (fakes.sessionsForgotten?.on === true) {
        throw new Error("unknown playback session");
      }
      const peers = fakes.peersOf?.(statUrl) ?? 1;
      return { status: "dl", peers, speedDown: 0, speedUp: 0, downloaded: 0, uploaded: 0 };
    },
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
  const readerStatus = (sources: string[]): StandbyReaderStatus[] | undefined => {
    if (fakes.sources === undefined || real.active === undefined) {
      return undefined;
    }
    const data = fakes.standbyData ?? delivering();
    return sources.map((source) => ({
      source,
      state: data.has(source) ? "receiving" : "connecting",
      bytes: 0,
      lastDataAt: data.has(source) ? new Date(clock.now).toISOString() : null,
      error: data.has(source) ? null : (fakes.standbyError?.value ?? null),
      liveEdge:
        fakes.standbyStale?.on === true
          ? { state: "stale", edgeAt: null, advancedAt: null, quietSince: null, behindSeconds: null }
          : null,
    }));
  };
  const transcoderStarts: string[] = [];
  const transcoder = {
    start: (_id: string, input: { source: string }, handover?: boolean) => {
      if (fakes.transcoderStartFails !== undefined && fakes.transcoderStartFails.left > 0) {
        fakes.transcoderStartFails.left -= 1;
        return Promise.reject(new Error("transcoder said no"));
      }
      transcoderStarts.push(input.source);
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
      if (fakes.transcoderDown?.on === true) {
        return Promise.reject(new Error("transcoder unreachable"));
      }
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
      const liveEdge = fakes.liveEdge?.value ?? null;
      return Promise.resolve(
        delivers
          ? { ...pipeline, source, liveEdge, lastFrameAt: new Date(clock.now).toISOString() }
          : { ...pipeline, source, liveEdge },
      );
    },
    stop: () => Promise.resolve(),
    setStandbys: (_id: string, standbys: StandbySource[]) => {
      if (fakes.transcoderDown?.on === true) {
        return Promise.reject(new Error("transcoder unreachable"));
      }
      const sources = standbys.map((standby) => standby.source);
      readers.push(sources);
      return Promise.resolve(readerStatus(sources));
    },
    // The readers the last `setStandbys` asked for, as they are now.
    standbyStatus: () =>
      fakes.transcoderDown?.on === true
        ? Promise.reject(new Error("transcoder unreachable"))
        : Promise.resolve(readerStatus(readers.at(-1) ?? [])),
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
  let saved: StreamConfig = {
    ...stream,
    ...(fakes.ownEngine !== undefined && { ownEngine: fakes.ownEngine }),
    ...(fakes.savedSession !== undefined && { session: fakes.savedSession }),
    ...(fakes.lastFrameAt !== undefined && { lastFrameAt: fakes.lastFrameAt }),
  };
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
    transcoderStarts,
    creates: () => creates,
    readers,
    updates,
    saved: () => saved,
    real,
    metrics,
  };
}

/** The stream's recoveries that brought video back, by the step that counted (see `RecoverySteps`). */
async function succeeded(fake: { metrics: ControllerMetrics }): Promise<Record<string, number>> {
  const { values } = await fake.metrics.recoveriesSucceeded.get();
  return Object.fromEntries(
    values
      .filter(({ value }) => value > 0)
      .map(({ labels, value }) => [String((labels as Record<string, unknown>)["action"]), value]),
  );
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

describe("a manual restart of a stream that has no session", () => {
  const SHORT = 1000;

  test("starts it at once instead of when the ladder's wait is over", async () => {
    const fake = supervisor([direct], { failFirstSession: true });
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "error", message: "engine died" });

    // Without a restart, the next start waits for the ladder.
    fake.clock.now += SHORT / 2;
    await fake.instance.tick();
    expect(fake.sessions()).toBe(1);

    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.sessions()).toBe(2);
    expect(fake.instance.view()).toMatchObject({ state: "starting", message: "opening stream", recoveries: 0 });
    expect(fake.restarted).toEqual([]);
  });

  test("starts a stream whose engine could not start at once", async () => {
    const failEngineStarts = { on: true };
    const fake = supervisor([direct], { failEngineStarts });
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "error", message: "docker said no" });
    failEngineStarts.on = false;
    fake.clock.now += SHORT / 2;
    await fake.instance.tick();
    expect(fake.creates()).toBe(1);

    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.creates()).toBe(2);
    expect(fake.sessions()).toBe(1);
    expect(fake.instance.view()).toMatchObject({ state: "starting", recoveries: 0 });
  });

  test("starts the ladder's waits over", async () => {
    const failEngineStarts = { on: true };
    const fake = supervisor([direct], { failEngineStarts });
    // Three failed starts: the next one would wait four times the first delay.
    for (const wait of [0, 1001, 2001]) {
      fake.clock.now += wait;
      await fake.instance.tick();
    }
    expect(fake.creates()).toBe(3);
    fake.clock.now += 1001;
    await fake.instance.tick();
    expect(fake.creates()).toBe(3);

    // It fails again, but the waits count from this try on: the first delay again.
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.creates()).toBe(4);
    fake.clock.now += 1001;
    await fake.instance.tick();
    expect(fake.creates()).toBe(5);
  });

  test("tries only once per request", async () => {
    const failEngineStarts = { on: true };
    const fake = supervisor([direct], { failEngineStarts });
    await fake.instance.tick();
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.creates()).toBe(2);
    // That start failed too: the ladder's wait applies again.
    fake.clock.now += SHORT / 2;
    await fake.instance.tick();
    expect(fake.creates()).toBe(2);
  });

  test("a request before the first check doesn't restart the engine it starts", async () => {
    const fake = supervisor([direct], { video: { on: true } });
    fake.instance.requestRestart();
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.creates()).toBe(1);
    expect(fake.restarted).toEqual([]);
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
  });

  test("a request while it starts, and it starts, doesn't restart the engine it started", async () => {
    const { promise: sessionGate, resolve: open } = Promise.withResolvers<undefined>();
    const fake = supervisor([direct], { video: { on: true }, sessionGate });
    const starting = fake.instance.tick();
    await setImmediate();
    fake.instance.requestRestart();
    open(undefined);
    await starting;
    await fake.instance.tick();
    expect(fake.creates()).toBe(1);
    expect(fake.restarted).toEqual([]);
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
  });

  test("a request while it starts, and it fails, starts it again at once", async () => {
    const { promise: sessionGate, resolve: open } = Promise.withResolvers<undefined>();
    const fake = supervisor([direct], { failFirstSession: true, sessionGate });
    const starting = fake.instance.tick();
    await setImmediate();
    fake.instance.requestRestart();
    open(undefined);
    await starting;
    expect(fake.instance.view().state).toBe("error");
    fake.clock.now += SHORT / 2;
    await fake.instance.tick();
    expect(fake.sessions()).toBe(2);
    expect(fake.instance.view()).toMatchObject({ state: "starting", recoveries: 0 });
  });

  test("a request while no path is up waits for one, and doesn't restart the engine that starts then", async () => {
    const paths: PathStatus[] = [{ ...direct, up: false }];
    const fake = supervisor(paths, { video: { on: true } });
    await fake.instance.tick();
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.creates()).toBe(0);
    expect(fake.instance.view().state).toBe("stalled");

    paths[0] = direct;
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.creates()).toBe(1);
    expect(fake.restarted).toEqual([]);
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
  });

  test("a stream that has a session restarts as before", async () => {
    const fake = supervisor([direct], { video: { on: true } });
    await fake.instance.tick();
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.restarted).toEqual([engine.containerId]);
    expect(fake.instance.view()).toMatchObject({ message: "manual restart; restart engine", recoveries: 1 });
  });
});

describe("recoveries that brought video back", () => {
  const vpn: PathStatus = { ...direct, id: "wg:a", kind: "wireguard", label: "VPN", score: 0.5 };

  /** A stream that played, then stalled: its ladder took `steps` steps that brought no video. */
  async function stalled(steps: number, fakes: Fakes = {}, paths: PathStatus[] = [direct]) {
    const video = { on: true };
    const fake = supervisor(paths, { video, ...fakes });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    video.on = false;
    for (let step = 0; step < steps; step += 1) {
      fake.clock.now += settings.startupGraceMs + 1000;
      await fake.instance.tick();
    }
    expect(fake.instance.view().recoveries).toBe(steps);
    return { ...fake, video };
  }

  test("counts one recovery once the stream plays again, under the last step, not the steps tried before", async () => {
    // The pipeline twice, then the engine.
    const fake = await stalled(3);
    expect(fake.instance.view()).toMatchObject({ state: "recovering", message: "no video after 61s; restart engine" });
    expect(await succeeded(fake)).toEqual({});

    fake.video.on = true;
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 3 });
    expect(await succeeded(fake)).toEqual({ "restart-engine": 1 });

    // It plays on: nothing more to count.
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(await succeeded(fake)).toEqual({ "restart-engine": 1 });

    // The next outage counts by itself.
    fake.video.on = false;
    fake.clock.now += settings.startupGraceMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.view().recoveries).toBe(4);
    expect(await succeeded(fake)).toEqual({ "restart-engine": 1 });
    fake.video.on = true;
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(await succeeded(fake)).toEqual({ "restart-engine": 1, "restart-pipeline": 1 });
  });

  test("a stream that waits for its broadcast counts its tries as attempts, and one recovery once it is back", async () => {
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = await stalled(0, { liveEdge });
    for (let second = 0; second <= 240; second += 1) {
      fake.clock.now += 1000;
      liveEdge.value = stale(fake.clock.now);
      await fake.instance.tick();
    }
    expect(fake.instance.view().state).toBe("stale-source");
    expect(fake.instance.view().recoveries).toBe(5);
    expect(await succeeded(fake)).toEqual({});

    liveEdge.value = { state: "live", edgeAt: null, advancedAt: null, quietSince: null, behindSeconds: 0 };
    fake.video.on = true;
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    expect(await succeeded(fake)).toEqual({ "restart-engine": 1 });
  });

  test("a restart by hand of a stream that doesn't play counts once it plays again", async () => {
    const fake = await stalled(1);
    fake.video.on = true;
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ message: "manual restart; restart engine", recoveries: 2 });
    expect(await succeeded(fake)).toEqual({});
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    expect(await succeeded(fake)).toEqual({ "restart-engine": 1 });
  });

  test("a restart by hand of a stream that plays is only an attempt", async () => {
    const fake = await stalled(0);
    fake.video.on = true;
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ message: "manual restart; restart engine", recoveries: 1 });
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    expect(await succeeded(fake)).toEqual({});
  });

  test("starts both counters at zero for every step, under the stream's id, before its first check", async () => {
    const fake = supervisor([direct]);
    const zero = ["restart-pipeline", "restart-engine", "switch-path", "failover"].map((action) => ({
      labels: { stream: "s1", action },
      value: 0,
    }));
    for (const counter of [fake.metrics.recoveries, fake.metrics.recoveriesSucceeded]) {
      const { values } = await counter.get();
      expect(values.map(({ labels, value }) => ({ labels, value }))).toEqual(zero);
    }
  });

  test("a restart by hand whose transcoder can't start leaves the credit with the step before it", async () => {
    const transcoderStartFails = { left: 0 };
    const fake = await stalled(1, { sessionIds: true, transcoderStartFails });
    transcoderStartFails.left = 1;
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "stalled", recoveries: 2 });
    expect(fake.instance.view().message).toMatch(/^restart engine failed: transcoder said no/);

    // The transcoder still reads the session of the pipeline the first step started, not the one
    // the restart opened: the video that comes is not the restart's.
    fake.video.on = true;
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    expect(await succeeded(fake)).toEqual({ "restart-pipeline": 1 });
  });

  test("a stream that starts, even after failed starts, recovered nothing", async () => {
    const video = { on: true };
    const fake = supervisor([direct], { failFirstSession: true, video });
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("error");
    fake.clock.now += settings.recoveryBaseDelayMs;
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
    expect(await succeeded(fake)).toEqual({});
  });

  test("a step that fails after it stopped the session counts once the start that follows brings video", async () => {
    const hold: Hold = {};
    const fake = await stalled(0, { hold });
    const refused = Promise.reject(new Error("engine said no"));
    refused.catch(() => undefined);
    hold.session = refused;
    fake.clock.now += settings.startupGraceMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "stalled", recoveries: 1 });
    expect(fake.instance.view().message).toMatch(/^restart pipeline failed/);

    // The start after the ladder's wait opens the session the step could not.
    hold.session = undefined;
    fake.video.on = true;
    fake.clock.now += settings.recoveryBaseDelayMs;
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 1 });
    expect(await succeeded(fake)).toEqual({ "restart-pipeline": 1 });
  });

  test("a path switch that brings no video leaves the credit with the step before it", async () => {
    const fake = await stalled(3, { created: [engine, own(2)], handover: "stops" }, [direct, vpn]);
    // Past the time a stream stays on a path, so the ladder's fourth step is a path switch.
    fake.clock.now += settings.pathMinDwellMs;
    await fake.instance.tick();
    expect(fake.handovers).toEqual([play(own(2))]);
    expect(fake.instance.view()).toMatchObject({ state: "stalled", path: "direct", recoveries: 4 });
    expect(fake.instance.view().message).toMatch(/^switch path failed/);

    // The engine the third step restarted delivers after all: the stream never left it.
    fake.video.on = true;
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", path: "direct", engine: { name: engine.name } });
    expect(await succeeded(fake)).toEqual({ "restart-engine": 1 });
  });

  test("a path switch that works counts as the path switch", async () => {
    const fake = await stalled(3, { created: [engine, own(2)], handover: "delivers" }, [direct, vpn]);
    fake.clock.now += settings.pathMinDwellMs;
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ path: "wg:a", recoveries: 4 });
    expect(await succeeded(fake)).toEqual({});
    fake.video.on = true;
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    expect(await succeeded(fake)).toEqual({ "switch-path": 1 });
  });
});

const iso = (ms: number): string => new Date(ms).toISOString();

/** The last frame times a supervisor saved to the store, in order. */
const frameSaves = (updates: Record<string, unknown>[]): unknown[] =>
  updates.filter((update) => "lastFrameAt" in update).map((update) => update["lastFrameAt"]);

describe("the time of a stream's last video", () => {
  test("stays while recovery starts the pipeline over, until new video comes", async () => {
    const sources = new Set([session.playbackUrl]);
    const { instance, clock, real, transcoderStarts } = supervisor([direct], { sources });
    await instance.tick();
    await instance.tick();
    const played = iso(clock.now);
    expect(instance.view()).toMatchObject({ state: "playing", lastFrameAt: played });

    // The video stops, and recovery starts the pipeline over. The new pipeline has no frame yet,
    // which used to show as a stream that never played.
    sources.clear();
    clock.now += settings.stallAfterMs + 1000;
    await instance.tick();
    expect(transcoderStarts).toHaveLength(2);
    expect(real.lastFrameAt).toBeNull();
    expect(instance.view()).toMatchObject({ state: "recovering", lastFrameAt: played });

    sources.add(session.playbackUrl);
    clock.now += 5000;
    await instance.tick();
    expect(instance.view()).toMatchObject({ state: "playing", lastFrameAt: iso(clock.now) });
  });

  test("is saved once a minute while the stream plays, and when it stops", async () => {
    const { instance, clock, updates, saved } = supervisor([direct], { video: { on: true } });
    await instance.tick();
    expect(frameSaves(updates)).toEqual([]);
    // The first video is saved at once: a stream that played is never one that never did.
    await instance.tick();
    const first = iso(clock.now);
    expect(frameSaves(updates)).toEqual([first]);

    for (let second = 1; second < 60; second += 1) {
      clock.now += 1000;
      await instance.tick();
    }
    expect(frameSaves(updates)).toEqual([first]);
    clock.now += 1000;
    await instance.tick();
    expect(frameSaves(updates)).toEqual([first, iso(clock.now)]);

    // Stopping doesn't wait for the minute to pass. A stopping controller saves what the last
    // check saw, without asking the transcoder again: the stream plays on without it.
    clock.now += 5000;
    await instance.tick();
    const checked = iso(clock.now);
    clock.now += 1500;
    await instance.stop(false);
    expect(frameSaves(updates)).toEqual([first, iso(clock.now - 6500), checked]);
    expect(saved().lastFrameAt).toBe(checked);
  });

  test("is not saved again while no new video comes", async () => {
    const video = { on: true };
    const { instance, clock, updates } = supervisor([direct], { video });
    await instance.tick();
    await instance.tick();
    video.on = false;
    for (let minute = 0; minute < 3; minute += 1) {
      clock.now += 61_000;
      await instance.tick();
    }
    await instance.stop(false);
    expect(frameSaves(updates)).toHaveLength(1);
  });

  test("counts the frames that came after the last check, when the stream is removed or disabled", async () => {
    const { instance, clock, saved } = supervisor([direct], { video: { on: true } });
    await instance.tick();
    await instance.tick();
    // The pipeline went on for a while after the last check.
    clock.now += 30_000;
    await instance.stop(true);
    expect(saved().lastFrameAt).toBe(iso(clock.now));
    expect(instance.view()).toMatchObject({ state: "stopped", lastFrameAt: iso(clock.now) });
  });

  test("starts from the saved one, and a change of the config keeps the newer of the two", async () => {
    const before = iso(500);
    const { instance, clock, saved } = supervisor([direct], { video: { on: true }, lastFrameAt: before });
    // The stream played in an earlier run and has no video yet in this one.
    await instance.tick();
    expect(instance.view().lastFrameAt).toBe(before);
    await instance.tick();
    const played = iso(clock.now);
    expect(instance.view().lastFrameAt).toBe(played);

    clock.now += 1000;
    // A rename comes with the stored config, whose frame time is the one last saved.
    instance.updateConfig({ ...saved(), name: "Renamed", lastFrameAt: before });
    expect(instance.view()).toMatchObject({ name: "Renamed", lastFrameAt: played });
  });
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

describe("taking over the playback after a controller restart", () => {
  const restarted = { found: [engine], ownEngine: engine.name, savedSession: session };

  test("takes over the session and the ffmpeg reading it, so the picture never stops", async () => {
    const fake = supervisor([direct], { ...restarted, video: { on: true } });
    await fake.instance.tick();
    expect(fake.sessions()).toBe(0);
    expect(fake.transcoderStarts).toEqual([]);
    expect(fake.stopped).toEqual([]);
    expect(fake.saved().session).toEqual(session);

    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
    expect(fake.sessions()).toBe(0);
  });

  test("on a shared engine too", async () => {
    const shared: EngineHandle = { ...engine, containerId: "shared-1", streamId: "", sharedPath: "direct" };
    const pool = {
      acquire: () => Promise.resolve(shared),
      isCurrent: () => true,
      release: () => Promise.resolve(),
    } as unknown as SharedEngines;
    const fake = supervisor([direct], { savedSession: session, shared: pool, sharing: { on: true } });
    await fake.instance.tick();
    expect(fake.sessions()).toBe(0);
    expect(fake.transcoderStarts).toEqual([]);
  });

  test("counts health from when that playback started, without a new startup grace", async () => {
    // The ffmpeg it took over never showed video.
    const fake = supervisor([direct], restarted);
    fake.clock.now = Date.parse(pipeline.startedAt) + settings.startupGraceMs + 1000;
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("recovering");
  });

  test("starts the stream when the transcoder reads another source, and stops the old session", async () => {
    const old = { ...session, playbackUrl: `${engine.baseUrl}/old`, commandUrl: `${engine.baseUrl}/old-cmd` };
    const fake = supervisor([direct], { ...restarted, savedSession: old });
    await fake.instance.tick();
    expect(fake.stopped).toEqual([old.commandUrl]);
    expect(fake.sessions()).toBe(1);
    expect(fake.transcoderStarts).toEqual([`${engine.baseUrl}/play`]);
    expect(fake.saved().session?.playbackUrl).toBe(`${engine.baseUrl}/play`);
  });

  test("starts the stream when the previous run stopped in the middle of a move", async () => {
    const old = { ...session, playbackUrl: `${engine.baseUrl}/old`, commandUrl: `${engine.baseUrl}/old-cmd` };
    const fake = supervisor([direct], { ...restarted, savedSession: old, sources: new Set([old.playbackUrl]) });
    // The transcoder plays from the saved session, and still waits for video from another engine,
    // which it would cut over to.
    fake.real.active = old.playbackUrl;
    fake.real.pending = "http://172.31.250.77:6878/play";
    fake.real.since = fake.clock.now;
    await fake.instance.tick();
    expect(fake.stopped).toEqual([old.commandUrl]);
    expect(fake.sessions()).toBe(1);
    expect(fake.transcoderStarts).toEqual([`${engine.baseUrl}/play`]);
    expect(fake.real.pending).toBeUndefined();
  });

  test("tries again once the transcoder answers, rather than starting the stream while it can't be reached", async () => {
    const transcoderDown = { on: true };
    const fake = supervisor([direct], { ...restarted, video: { on: true }, transcoderDown });
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("error");
    expect(fake.sessions()).toBe(0);
    expect(fake.stopped).toEqual([]);
    expect(fake.saved().session).toEqual(session);

    transcoderDown.on = false;
    fake.clock.now += settings.recoveryMaxDelayMs;
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    expect(fake.sessions()).toBe(0);
    expect(fake.transcoderStarts).toEqual([]);
    expect(fake.stopped).toEqual([]);
  });

  test("starts the stream when the engine no longer knows the session", async () => {
    const fake = supervisor([direct], { ...restarted, sessionsForgotten: { on: true } });
    await fake.instance.tick();
    expect(fake.stopped).toEqual([]);
    expect(fake.sessions()).toBe(1);
    expect(fake.transcoderStarts).toHaveLength(1);
  });

  test("starts the stream when the engine came back on another address", async () => {
    const moved: EngineHandle = { ...engine, ip: "172.31.250.99", baseUrl: "http://172.31.250.99:6878" };
    const fake = supervisor([direct], { ...restarted, reviveAs: new Map([[engine.containerId, moved]]) });
    await fake.instance.tick();
    expect(fake.sessions()).toBe(1);
    expect(fake.transcoderStarts).toEqual([`${moved.baseUrl}/play`]);
    // Whatever engine has its old address now, it shouldn't pull the stream for nobody.
    expect(fake.stopped).toEqual([session.commandUrl]);
    expect(fake.saved().session?.playbackUrl).toBe(`${moved.baseUrl}/play`);
  });

  test("forgets the session once it stops, and remembers the next one", async () => {
    const fake = supervisor([direct], { ...restarted, video: { on: true } });
    await fake.instance.tick();
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.updates).toContainEqual({ session: null });
    expect(fake.saved().session).toEqual(session);
    expect(fake.sessions()).toBe(1);
  });
});

test("shutting down waits only a moment for a step in progress", async () => {
  const fake = supervisor([direct], { hangSessions: true });
  fake.instance.start();
  // The first tick starts the engine, then waits forever for its session.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = Date.now();
  await fake.instance.stop(false, 50);
  expect(Date.now() - started).toBeLessThan(1000);
});

describe("starting behind the stream's previous run", () => {
  test("does nothing until that run is gone, and says what it waits for", async () => {
    const fake = supervisor([direct], { video: { on: true } });
    const previous = Promise.withResolvers<undefined>();
    fake.instance.start(previous.promise);
    expect(fake.instance.view()).toMatchObject({ state: "starting", message: "waiting for the previous run to stop" });
    // It has no engine to assign yet, so the others needn't wait for it.
    expect(fake.instance.settled).toBe(true);
    expect(fake.instance.triedEngine).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.creates()).toBe(0);
    expect(fake.transcoderStarts).toEqual([]);

    previous.resolve(undefined);
    await vi.waitFor(() => {
      expect(fake.transcoderStarts).toHaveLength(1);
    });
    expect(fake.creates()).toBe(1);
    await fake.instance.stop(true);
  });

  test("starts when that run's teardown failed", async () => {
    const fake = supervisor([direct], { video: { on: true } });
    fake.instance.start(Promise.reject(new Error("docker said no")));
    await vi.waitFor(() => {
      expect(fake.transcoderStarts).toHaveLength(1);
    });
    await fake.instance.stop(true);
  });

  test("stopped meanwhile, it starts nothing and is torn down once that run is gone", async () => {
    const fake = supervisor([direct]);
    const previous = Promise.withResolvers<undefined>();
    fake.instance.start(previous.promise);
    let stopped = false;
    const stopping = fake.instance.stop(true).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);

    previous.resolve(undefined);
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.creates()).toBe(0);
    expect(fake.transcoderStarts).toEqual([]);
    expect(fake.instance.view().state).toBe("stopped");
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
    // The metrics label it as kept, on the path it is on.
    expect(instance.engines.kept).toEqual({ engine: replacement.name, path: "wg:a" });

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
    // The path switch that gave up brought the video back after all, which counts once it plays.
    expect(await succeeded(fake)).toEqual({});
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 1 });
    expect(fake.removed).toEqual([engine.containerId]);
    expect(await succeeded(fake)).toEqual({ "switch-path": 1 });
  });

  test("counts the move whose video arrived late, even when removing the engine it left failed", async () => {
    const sources = new Set([`${engine.baseUrl}/play`]);
    const paths = [direct, vpn];
    const spareSlots = new MoveSlots(1);
    const fake = supervisor(paths, { created: [engine, replacement], sources, spareSlots, failRemove: true });
    await fake.instance.tick();
    await fake.instance.tick();
    paths[0] = { ...direct, up: false };
    sources.clear();
    fake.clock.now += settings.stallAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.real.active).toBe(`${replacement.baseUrl}/play`);
    expect(fake.instance.path).toBe("direct");

    sources.add(`${replacement.baseUrl}/play`);
    await expect(fake.instance.tick()).rejects.toThrow("docker said no");
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view().engine?.name).toBe(replacement.name);
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 1 });
    expect(await succeeded(fake)).toEqual({ "switch-path": 1 });
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

  test("a stream that plays again after it moved off the direct path recovered nothing", async () => {
    const { state, pathAllowed } = policy(false);
    const video = { on: true };
    const fake = supervisor([direct, vpn], {
      created: [engine, replacement],
      handover: "delivers",
      pathAllowed,
      video,
    });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    state.on = true;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
    expect(await succeeded(fake)).toEqual({});
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

/** A live edge the transcoder found stale: it last moved 61 s ago, and it is the same since. */
function stale(now: number): LiveEdgeView {
  return {
    state: "stale",
    edgeAt: new Date(0).toISOString(),
    advancedAt: new Date(now - 61_000).toISOString(),
    quietSince: new Date(now - 61_000).toISOString(),
    behindSeconds: 0,
  };
}

describe("a broadcast that sends nothing new (stale source)", () => {
  test("waits for the broadcast with growing waits instead of restarting on every stall", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    const opened = fake.sessions();

    // The transcoder found the source's live edge stale: it stopped reading it.
    video.on = false;
    liveEdge.value = stale(fake.clock.now);
    await fake.instance.tick();
    expect(fake.sessions()).toBe(opened + 1);
    expect(fake.instance.view()).toMatchObject({
      state: "stale-source",
      message: "no new data from the broadcast for 61s; restart engine",
    });

    // The new session only has the old window too.
    const states = new Set<string>();
    const actions: number[] = [];
    for (let second = 1; second <= 240; second += 1) {
      fake.clock.now += 1000;
      liveEdge.value = stale(fake.clock.now);
      const before = fake.sessions() + fake.restarted.length;
      await fake.instance.tick();
      states.add(fake.instance.view().state);
      if (fake.sessions() + fake.restarted.length > before) {
        actions.push(second);
      }
    }
    // 30 s, then 60 s (the stale waits double, up to RECOVERY_MAX_DELAY_SECONDS: 60 s here).
    expect(actions).toEqual([30, 90, 150, 210]);
    // Every try replaces the engine, the one at the start too.
    expect(fake.restarted).toHaveLength(5);
    expect([...states]).toEqual(["stale-source"]);
    expect(fake.instance.view().message).toMatch(
      /^no new data from the broadcast for 61s; trying a new engine in \d+s$/,
    );
  });

  test("restarts at once by hand while it waits, and its waits start over from there", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    video.on = false;
    // Three tries already, the last one a minute ago: the next one would come in a minute.
    for (const step of [0, 30, 60]) {
      fake.clock.now += step * 1000 + 1;
      liveEdge.value = stale(fake.clock.now);
      await fake.instance.tick();
    }
    expect(fake.restarted).toHaveLength(3);
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view().message).toMatch(/trying a new engine in \d+s$/);

    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(4);
    expect(fake.instance.view()).toMatchObject({ state: "stale-source", message: "manual restart; restart engine" });
    // The next try comes after the first wait again (30 s), not after the longer one it was at.
    fake.clock.now += 29_000;
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(4);
    fake.clock.now += 2000;
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(5);
  });

  test("plays again once a new session's live edge moves, and waits as usual after that", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    video.on = false;
    liveEdge.value = stale(fake.clock.now);
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("stale-source");

    // A try while it waits shows as waiting for the broadcast, not as a start.
    liveEdge.value = { state: "waiting", edgeAt: null, advancedAt: null, quietSince: null, behindSeconds: null };
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({
      state: "stale-source",
      message: "waiting for the broadcast; waiting for video",
    });

    liveEdge.value = { state: "live", edgeAt: null, advancedAt: null, quietSince: null, behindSeconds: 0 };
    video.on = true;
    fake.clock.now += 1000;
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", message: null });

    // A stall after that is an ordinary one again.
    video.on = false;
    fake.clock.now += settings.startupGraceMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({
      state: "recovering",
      message: "no video after 63s; restart pipeline",
    });
  });
});

/** A session the transcoder stopped reading because its engine serves a broadcast that goes on 103 s late. */
function lagging(now: number): LiveEdgeView {
  return {
    state: "stale",
    staleBecause: "behind",
    edgeAt: new Date(now - 2000).toISOString(),
    advancedAt: new Date(now - 1000).toISOString(),
    quietSince: new Date(now - 1000).toISOString(),
    behindSeconds: 103,
  };
}

describe("an engine that serves a broadcast that goes on too far behind (lagging)", () => {
  test("is replaced at once when a wait for the broadcast ends on it, also after the wait's early try", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    video.on = false;
    // The broadcast stops: the stream waits for it.
    liveEdge.value = stale(fake.clock.now);
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("stale-source");
    expect(fake.restarted).toHaveLength(1);

    // The live edge moves again: the wait's one early try opens a new engine.
    fake.clock.now += settings.startupGraceMs + 1000;
    const moved = new Date(fake.clock.now).toISOString();
    liveEdge.value = { state: "waiting", edgeAt: moved, advancedAt: moved, quietSince: moved, behindSeconds: 0 };
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(2);
    expect(fake.instance.view().state).toBe("stale-source");

    // That engine serves the broadcast 103 s late, and the transcoder stopped reading it. The wait's
    // next try is half a minute away and its early try is used: the engine is replaced now.
    fake.clock.now += 3000;
    liveEdge.value = lagging(fake.clock.now);
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(3);
    expect(fake.instance.view()).toMatchObject({
      state: "recovering",
      message: "the engine serves the broadcast 103s late; restart engine",
    });

    // Every next engine lags too: they are not replaced back to back, the usual waits double.
    const states = new Set<string>();
    const actions: number[] = [];
    for (let second = 1; second <= 40; second += 1) {
      fake.clock.now += 1000;
      liveEdge.value = lagging(fake.clock.now);
      const before = fake.restarted.length;
      await fake.instance.tick();
      states.add(fake.instance.view().state);
      if (fake.restarted.length > before) {
        actions.push(second);
      }
    }
    expect(actions).toEqual([1, 3, 7, 15, 31]);
    expect(states.has("stale-source")).toBe(false);
    expect(fake.instance.view().message).toMatch(/^the engine serves the broadcast 103s late; retrying in \d+s$/);

    // The broadcast stops again: the stream waits for it again, with the longer waits.
    fake.clock.now += 1000;
    liveEdge.value = stale(fake.clock.now);
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(8);
    expect(fake.instance.view()).toMatchObject({ state: "stale-source" });
    expect(fake.instance.view().message).toMatch(/trying a new engine in \d+s$/);
  });

  test("keeps doubling the waits when every engine lags and is slow to show where it serves", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    video.on = false;

    // What a transcoder says of engines that each take 20 s to show a live position, 103 s behind a
    // broadcast that goes on. A session sees new data once it watched its edge move for 3 s, and a
    // session far behind is "behind" only while one saw new data within the last 60 s: engines
    // replaced as soon as they show up never do, so after a minute of them it says "quiet" for a moment.
    const startMs = 20_000;
    let newDataAt = fake.clock.now;
    let startedAt = fake.clock.now - startMs;
    let seenAt: number | undefined = fake.clock.now - 3000;
    let engines = fake.restarted.length;
    const replacedAt: number[] = [];
    let waits = 0;
    let waiting = false;
    for (let second = 1; second <= 1800; second += 1) {
      fake.clock.now += 1000;
      const now = fake.clock.now;
      if (now - startedAt < startMs) {
        liveEdge.value = null;
      } else {
        seenAt ??= now;
        newDataAt = now - seenAt >= 3000 ? now : newDataAt;
        liveEdge.value = {
          ...lagging(now),
          staleBecause: now - newDataAt <= 60_000 ? "behind" : "quiet",
          quietSince: new Date(newDataAt).toISOString(),
        };
      }
      await fake.instance.tick();
      if (fake.restarted.length > engines) {
        engines = fake.restarted.length;
        startedAt = now;
        seenAt = undefined;
        replacedAt.push(second);
      }
      const waitsNow = fake.instance.view().state === "stale-source";
      waits += waitsNow && !waiting ? 1 : 0;
      waiting = waitsNow;
    }
    const gaps = replacedAt.slice(1).map((at, index) => at - (replacedAt[index] ?? 0));
    // The first engines go as soon as they show up, 20 s apart: the ladder's waits of 1 to 16 s
    // are over by then (the fourth one goes 3 s later, once the transcoder says "behind" again).
    // Then the waits go on doubling, to 32 s and the longest one, and stay there. A ladder that
    // started over at each wait would keep the engines 20 s apart for good.
    expect(gaps.slice(0, 6)).toEqual([20, 20, 20, 23, 20, 32]);
    expect(new Set(gaps.slice(6))).toEqual(new Set([settings.recoveryMaxDelayMs / 1000]));
    expect(replacedAt).toHaveLength(34);
    // "Waiting for source" showed for that one moment, not again and again while engines lag.
    expect(waits).toBe(1);
  });

  test("waits its turn after a restart by hand during the wait, which started the ladder over", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    video.on = false;
    liveEdge.value = stale(fake.clock.now);
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("stale-source");
    fake.clock.now += 5000;
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(2);

    // The engine of the restart by hand lags: it goes after the ladder's first wait from that
    // restart, not at once as it would on the ladder from before the wait.
    liveEdge.value = lagging(fake.clock.now);
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(2);
    expect(fake.instance.view()).toMatchObject({
      state: "stalled",
      message: "the engine serves the broadcast 103s late; retrying in 1s",
    });
    fake.clock.now += 1000;
    liveEdge.value = lagging(fake.clock.now);
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(3);
  });

  test("is replaced at once when the wait went on for long after a restart by hand", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    video.on = false;
    liveEdge.value = stale(fake.clock.now);
    await fake.instance.tick();
    fake.clock.now += 5000;
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(2);

    // The broadcast stays off for ten more minutes: the wait's tries go on, a minute apart by then.
    for (let second = 1; second <= 600; second += 1) {
      fake.clock.now += 1000;
      liveEdge.value = stale(fake.clock.now);
      await fake.instance.tick();
    }
    const tries = fake.restarted.length;
    expect(tries).toBeGreaterThan(8);
    expect(fake.instance.view().state).toBe("stale-source");

    // It is back, and the engine of the last try lags. Those tries were for a broadcast that sent
    // nothing: the engine goes now, not after the wait they would add up to on the usual ladder.
    fake.clock.now += 1000;
    liveEdge.value = lagging(fake.clock.now);
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(tries + 1);
    expect(fake.instance.view()).toMatchObject({
      state: "recovering",
      message: "the engine serves the broadcast 103s late; restart engine",
    });
  });

  test("goes on from a fresh ladder after a restart by hand of a stream that had no session", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const failSessions = { on: false };
    const fake = supervisor([direct], { video, liveEdge, failSessions });
    await fake.instance.tick();
    await fake.instance.tick();
    video.on = false;
    liveEdge.value = stale(fake.clock.now);
    await fake.instance.tick();
    // A restart by hand: the wait remembers the ladder after it, one step in.
    fake.clock.now += 5000;
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(2);
    // The wait's next try can't open a session: the stream has none.
    failSessions.on = true;
    fake.clock.now += 30_001;
    liveEdge.value = stale(fake.clock.now);
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(3);
    expect(fake.instance.view().message).toBe("restart engine failed: engine died");
    failSessions.on = false;

    // A restart by hand starts it now, and the ladder over: the wait remembers that one instead.
    fake.clock.now += 1000;
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({
      state: "stale-source",
      message: "opening stream",
    });

    // Its engine lags, and so does the next one: the first goes at once, the second after the
    // ladder's first wait (1 s). On the ladder the wait remembered before, that would be its second (2 s).
    fake.clock.now += 1000;
    liveEdge.value = lagging(fake.clock.now);
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(4);
    fake.clock.now += 1000;
    liveEdge.value = lagging(fake.clock.now);
    await fake.instance.tick();
    expect(fake.restarted).toHaveLength(5);
  });

  test("is replaced at once when a stream that played falls behind, and counts as a recovery", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("playing");
    const recoveries = fake.instance.view().recoveries;

    video.on = false;
    liveEdge.value = lagging(fake.clock.now);
    await fake.instance.tick();
    // A new engine, not a new session on the one that lags.
    expect(fake.restarted).toHaveLength(1);
    expect(fake.instance.view()).toMatchObject({
      state: "recovering",
      message: "the engine serves the broadcast 103s late; restart engine",
      recoveries: recoveries + 1,
    });
  });
});

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

  test("keeps counting how long the broadcast sent nothing new when a retry opens on a newer window", async () => {
    const video = { on: true };
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { video, liveEdge });
    await fake.instance.tick();
    await fake.instance.tick();
    const lastNewData = fake.clock.now;

    // The broadcast stopped. Eleven minutes later a retry's session, which started a minute ago,
    // is stale too: its own edge was first seen then, but nothing new came since the broadcast stopped.
    video.on = false;
    fake.clock.now += 660_000;
    liveEdge.value = { ...stale(fake.clock.now), quietSince: new Date(lastNewData).toISOString() };
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({
      state: "stale-source",
      message: expect.stringContaining("no new data from the broadcast for 11m;") as string,
    });
  });

  test("doesn't blame the shared engine for a broadcast that sends nothing new", async () => {
    const pool = sharedEngines();
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true }, viewers: 1, liveEdge });
    await fake.instance.tick();
    liveEdge.value = {
      state: "stale",
      edgeAt: null,
      advancedAt: new Date(fake.clock.now - 61_000).toISOString(),
      quietSince: new Date(fake.clock.now - 61_000).toISOString(),
      behindSeconds: 0,
    };
    await stallAndRecover(fake, 3);
    expect(pool.reports).toEqual([]);
    expect(fake.instance.view().state).toBe("stale-source");
  });

  test("blames the shared engine for serving a broadcast that goes on too far behind", async () => {
    const pool = sharedEngines();
    const liveEdge: { value: LiveEdgeView | null } = { value: null };
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true }, viewers: 1, liveEdge });
    await fake.instance.tick();
    liveEdge.value = lagging(fake.clock.now);
    await stallAndRecover(fake, 1);
    expect(pool.reports).toHaveLength(1);
    expect(pool.reports[0]).toMatchObject({ wantsRestart: true });
    expect(fake.instance.view().state).not.toBe("stale-source");
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

  test("a manual restart while the stream starts on the shared engine doesn't replace that engine", async () => {
    const pool = sharedEngines();
    const { promise: sessionGate, resolve: open } = Promise.withResolvers<undefined>();
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true }, sessionGate, video: { on: true } });
    const starting = fake.instance.tick();
    await setImmediate();
    fake.instance.requestRestart();
    open(undefined);
    await starting;
    await fake.instance.tick();
    expect(pool.restarts).toEqual([]);
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
  });

  test("a manual restart while the gateway's paths are unknown waits for them, then starts without a restart", async () => {
    const pool = sharedEngines();
    const paths: PathStatus[] = [];
    const fake = supervisor(paths, { shared: pool.shared, sharing: { on: true }, video: { on: true } });
    await fake.instance.tick();
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.instance.view().message).toBe("waiting for the network gateway");
    expect(pool.acquired).toEqual([]);

    paths.push(direct);
    await fake.instance.tick();
    await fake.instance.tick();
    expect(pool.acquired).toEqual(["direct"]);
    expect(pool.restarts).toEqual([]);
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
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

  test("a manual restart of a stream whose start failed starts it at once, and doesn't replace the engine", async () => {
    const pool = sharedEngines();
    const fake = supervisor([direct], { shared: pool.shared, sharing: { on: true }, failFirstSession: true });
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("error");
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.sessions()).toBe(2);
    expect(fake.instance.view()).toMatchObject({ state: "starting", recoveries: 0 });
    // It started, so there was nothing to restart: the engine other streams play from stays.
    await fake.instance.tick();
    expect(pool.restarts).toEqual([]);
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

/** A promise that stays pending until `open` is called. */
function latch() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    promise,
    open: () => {
      resolve(undefined);
    },
  };
}

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
    // Starts the engine and the stream. Standbys only start once it got video, on the next check.
    await fake.instance.tick();
    expect(fake.instance.view().standbys).toEqual([]);
    await fake.instance.tick();
    await settle();
    await fake.instance.tick();
    return { ...fake, paths, sources };
  }

  /** A manual restart whose new session never opens until `open` is called. */
  async function restarting(fakes: Fakes = {}) {
    const hold: Hold = {};
    const fake = await withStandby({ hold, ...fakes });
    const gate = latch();
    hold.session = gate.promise;
    fake.instance.requestRestart();
    const step = fake.instance.tick();
    await settle();
    return { ...fake, step, open: gate.open };
  }

  /** Restarts the stream by hand while its engine refuses every new session. */
  async function stuck(fakes: Fakes = {}) {
    const hold: Hold = {};
    const fake = await withStandby({ hold, ...fakes });
    const refused = Promise.reject(new Error("engine said no"));
    refused.catch(() => undefined);
    hold.session = refused;
    fake.instance.requestRestart();
    await fake.instance.tick();
    expect(fake.instance.view().state).toBe("stalled");
    return { ...fake, hold };
  }

  test("keeps a hot standby on the other path once the stream plays", async () => {
    const fake = await withStandby();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
    expect(fake.instance.view().standbys).toEqual([
      { path: "wg:a", state: "hot", engine: { name: standbyEngine.name, shared: false }, reason: null },
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

    expect(await succeeded(fake)).toEqual({});
    await fake.instance.tick();
    await settle();
    expect(fake.instance.view().state).toBe("playing");
    // The failover brought the video back.
    expect(await succeeded(fake)).toEqual({ failover: 1 });
    // It opened a new session there, which the transcoder reads.
    await fake.instance.tick();
    expect(fake.readers.at(-1)).toEqual([play(main)]);
  });

  test("remembers the engine and session it failed over to, for a restarted controller", async () => {
    const fake = await withStandby();
    expect(fake.saved()).toMatchObject({ ownEngine: main.name, session: { playbackUrl: play(main) } });
    fake.sources.delete(play(main));
    fake.clock.now += DEFAULT_STANDBY_SETTINGS.failoverAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.saved()).toMatchObject({
      ownEngine: standbyEngine.name,
      path: "wg:a",
      session: { playbackUrl: play(standbyEngine), commandUrl: `${standbyEngine.baseUrl}/cmd` },
    });
  });

  test("a restarted controller takes over the playback, removes the standby it finds and starts a new one", async () => {
    const saved = { playbackUrl: play(main), statUrl: `${main.baseUrl}/stat`, commandUrl: `${main.baseUrl}/cmd` };
    const next = own(3);
    const fake = supervisor([direct, vpn], {
      found: [standbyEngine, main],
      ownEngine: main.name,
      savedSession: saved,
      created: [next],
      sources: new Set([play(main), play(next)]),
      hotStandby: { on: true },
    });
    // The previous run's ffmpeg still reads the stream's session.
    fake.real.active = play(main);
    await fake.instance.tick();
    expect(fake.removed).toEqual([standbyEngine.containerId]);
    expect(fake.sessions()).toBe(0);

    await fake.instance.tick();
    await settle();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0, engine: { name: main.name } });
    expect(fake.instance.view().standbys).toEqual([
      { path: "wg:a", state: "hot", engine: { name: next.name, shared: false }, reason: null },
    ]);
    // Only the new standby opened a session, and no ffmpeg started: the stream's own went on.
    expect(fake.sessions()).toBe(1);
    expect(fake.transcoderStarts).toEqual([]);
    // The first check stops the readers the previous run left at the transcoder.
    expect(fake.readers[0]).toEqual([]);
  });

  describe("while a restart takes long", () => {
    test("keeps a standby hot while no check runs", async () => {
      const fake = await restarting();
      fake.clock.now += 30_000;
      // Nobody asked the transcoder for 30 s, so its last data looks old.
      expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a", state: "warming" }]);
      await fake.instance.observe();
      expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a", state: "hot" }]);
      // The restart stopped the stream's session: nothing to show of it until the new one is polled.
      expect(fake.instance.view()).toMatchObject({ peers: { connected: null }, downloadKBps: null });
      fake.open();
      await fake.step;
    });

    test("goes on when the transcoder can't be reached", async () => {
      const transcoderDown = { on: false };
      const fake = await restarting({ transcoderDown });
      transcoderDown.on = true;
      fake.clock.now += 30_000;
      await expect(fake.instance.observe()).resolves.toBeUndefined();
      expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a", state: "warming" }]);
      fake.open();
      await fake.step;
    });

    test("doesn't take the data of a standby that stopped for hot", async () => {
      const standbyData = new Set([play(standbyEngine)]);
      const fake = await restarting({ standbyData });
      standbyData.clear();
      fake.clock.now += 30_000;
      await fake.instance.observe();
      expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a", state: "warming" }]);
      fake.open();
      await fake.step;
    });
  });

  describe("while the stream can't open a session", () => {
    test("keeps learning which standbys are hot", async () => {
      const fake = await stuck();
      for (let check = 0; check < 5; check += 1) {
        fake.clock.now += 6000;
        await fake.instance.tick();
      }
      expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a", state: "hot" }]);
    });

    test("removes its standbys when hot standby is turned off", async () => {
      const hotStandby = { on: true };
      const fake = await stuck({ hotStandby });
      expect(fake.instance.view().standbys).toHaveLength(1);
      hotStandby.on = false;
      fake.clock.now += 6000;
      await fake.instance.tick();
      await settle();
      expect(fake.instance.view().standbys).toEqual([]);
      expect(fake.removed).toEqual([standbyEngine.containerId]);
    });

    test("removes its standbys once it has not played for a while", async () => {
      const fake = await stuck();
      expect(fake.instance.view().standbys).toHaveLength(1);
      fake.clock.now += 11 * 60_000;
      await fake.instance.tick();
      await settle();
      expect(fake.instance.view().standbys).toEqual([]);
    });
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
    expect(fake.instance.view()).toMatchObject({ state: "recovering", path: "direct", recoveries: 2 });
    expect(fake.real.active).toBe(play(main));

    // The ladder's step brings the video back, not the failover that failed.
    fake.sources.add(play(main));
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", path: "direct" });
    expect(await succeeded(fake)).toEqual({ "restart-pipeline": 1 });
  });

  test("a failover that gives up counts nothing when the stream then plays on by itself", async () => {
    const hold: Hold = {};
    const standbyData = new Set([play(standbyEngine)]);
    const policy = { baseDelayMs: 600_000, maxDelayMs: 600_000 };
    const fake = await withStandby({ standbyData, standby: { policy }, hold });
    fake.sources.delete(play(main));
    fake.sources.delete(play(standbyEngine));
    fake.clock.now += DEFAULT_STANDBY_SETTINGS.failoverAfterMs + 1000;
    // The check sees the stall, and then the engine answers again while the failover waits.
    const gate = latch();
    hold.stats = new Map([[`${main.baseUrl}/stat`, gate.promise]]);
    const step = fake.instance.tick();
    await settle();
    fake.sources.add(play(main));
    hold.stats.clear();
    gate.open();
    await step;
    expect(fake.handovers).toEqual([play(standbyEngine)]);
    expect(fake.instance.view()).toMatchObject({ state: "stalled", path: "direct", recoveries: 1 });
    expect(fake.instance.view().message).toMatch(/^failing over to wg:a failed/);

    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", path: "direct", recoveries: 1 });
    expect(await succeeded(fake)).toEqual({});
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
    // The path stays listed while it waits for a new standby, with why the last one failed.
    expect(fake.instance.view().standbys).toEqual([
      { path: "wg:a", state: "failed", engine: null, reason: expect.stringMatching(/^no data for \d+s$/) as string },
    ]);
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 0 });
  });

  test("doesn't fail over while the transcoder can't be reached", async () => {
    const transcoderDown = { on: false };
    const fake = await withStandby({ transcoderDown });
    transcoderDown.on = true;
    for (let second = 0; second < 18; second += 2) {
      fake.clock.now += 2000;
      await fake.instance.tick();
    }
    expect(fake.instance.path).toBe("direct");
    expect(fake.handovers).toEqual([]);
  });

  test("doesn't fail over when the broadcast pauses on every path", async () => {
    const fake = await withStandby();
    fake.sources.clear();
    for (let second = 0; second < 18; second += 2) {
      fake.clock.now += 2000;
      await fake.instance.tick();
    }
    expect(fake.instance.path).toBe("direct");
    expect(fake.handovers).toEqual([]);
  });

  test("finishes a failover whose video arrives after it gave up", async () => {
    const standbyData = new Set([play(standbyEngine)]);
    const policy = { baseDelayMs: 600_000, maxDelayMs: 600_000 };
    const arrives = new Map<string, number>();
    const fake = await withStandby({ standbyData, arrives, standby: { policy } });
    fake.sources.delete(play(main));
    fake.sources.delete(play(standbyEngine));
    fake.clock.now += DEFAULT_STANDBY_SETTINGS.failoverAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("direct");
    // The transcoder kept reading the standby, and its video comes now.
    arrives.set(play(standbyEngine), fake.clock.now);
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view().engine?.name).toBe(standbyEngine.name);
    expect(fake.handovers).toEqual([play(standbyEngine)]);
    expect(fake.creates()).toBe(2);
    // The failover that gave up brought the video back after all.
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", recoveries: 1 });
    expect(await succeeded(fake)).toEqual({ failover: 1 });
  });

  test("leaves a standby alone while the transcoder still waits for its video", async () => {
    const standbyData = new Set([play(standbyEngine)]);
    const policy = { baseDelayMs: 600_000, maxDelayMs: 600_000 };
    // A standby that brings no data starts again at once.
    const fake = await withStandby({ standbyData, standby: { policy, warmupMs: 0 } });
    fake.sources.delete(play(main));
    fake.sources.delete(play(standbyEngine));
    fake.clock.now += DEFAULT_STANDBY_SETTINGS.failoverAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("direct");
    // The transcoder took over the standby's session from its reader, so no data comes from it
    // while the transcoder reads it. Starting it again would cut the video the transcoder waits for.
    standbyData.clear();
    await fake.instance.tick();
    await settle();
    expect(fake.restarted).toEqual([]);
    expect(fake.removed).toEqual([]);
  });

  test("starting a standby engine again waits for a start slot", async () => {
    const standbyStarts = new MoveSlots(1);
    const fake = await withStandby({ standbyData: new Set(), standbyStarts });
    // Another stream's standby starts meanwhile.
    expect(standbyStarts.tryTake()).toBe(true);
    for (let tick = 0; tick < 30; tick += 1) {
      fake.clock.now += 5000;
      await fake.instance.tick();
      await settle();
    }
    expect(fake.restarted).toEqual([]);
    standbyStarts.release();
    fake.clock.now += 5000;
    await fake.instance.tick();
    await settle();
    expect(fake.restarted).toEqual([standbyEngine.containerId]);
  });

  test("gives up on a path that keeps losing its standbys, until the path goes down", async () => {
    const fake = await withStandby({ standbyData: new Set() });
    let removals = 0;
    for (let tick = 0; tick < 1000; tick += 1) {
      fake.clock.now += 10_000;
      await fake.instance.tick();
      await settle();
      removals = fake.removed.length;
    }
    // Three rounds of three tries each, then no more.
    expect(removals).toBe(3);
    expect(fake.creates()).toBe(4);
    // It says so, rather than reading as if there were no other path to use.
    expect(fake.instance.view().standbys).toEqual([
      {
        path: "wg:a",
        state: "failed",
        engine: null,
        reason: expect.stringMatching(/^gave up, no data for \d+s$/) as string,
      },
    ]);

    fake.paths[1] = { ...vpn, up: false };
    await fake.instance.tick();
    fake.paths[1] = vpn;
    await fake.instance.tick();
    await settle();
    expect(fake.creates()).toBe(5);
    expect(fake.instance.view().standbys).toMatchObject([
      { path: "wg:a", state: expect.stringMatching(/starting|warming/) as string, reason: null },
    ]);
  });

  test("says why a standby is not hot: what its reader reports, and that its broadcast is stale", async () => {
    const standbyError = { value: "ffmpeg decoded no video from it" as string | null };
    const standbyStale = { on: false };
    const standbyData = new Set<string>();
    const fake = await withStandby({ standbyData, standbyError, standbyStale });
    await fake.instance.tick();
    expect(fake.instance.view().standbys).toEqual([
      {
        path: "wg:a",
        state: "warming",
        engine: { name: standbyEngine.name, shared: false },
        reason: "ffmpeg decoded no video from it",
      },
    ]);
    standbyError.value = null;
    standbyStale.on = true;
    await fake.instance.tick();
    expect(fake.instance.view().standbys).toMatchObject([
      { state: "warming", reason: "its broadcast sends no new data" },
    ]);
    // Once its data comes, there is nothing to say.
    standbyStale.on = false;
    standbyData.add(play(standbyEngine));
    await fake.instance.tick();
    expect(fake.instance.view().standbys).toMatchObject([{ state: "hot", reason: null }]);
  });

  test("keeps the reader's note in the reason a failed standby gives, and says nothing once hot standby is off", async () => {
    const hotStandby = { on: true };
    const standbyError = { value: "the engine answered 500" as string | null };
    const fake = await withStandby({ standbyData: new Set(), standbyError, hotStandby });
    // After its first failed try it still exists, and gives that reason too.
    for (let tick = 0; tick < 200 && fake.restarted.length === 0; tick += 1) {
      fake.clock.now += 5000;
      await fake.instance.tick();
      await settle();
    }
    expect(fake.instance.view().standbys).toMatchObject([
      { path: "wg:a", state: "failed", engine: { name: standbyEngine.name }, reason: "the engine answered 500" },
    ]);
    for (let tick = 0; tick < 200 && fake.removed.length === 0; tick += 1) {
      fake.clock.now += 5000;
      await fake.instance.tick();
      await settle();
    }
    expect(fake.instance.view().standbys).toMatchObject([
      { path: "wg:a", state: "failed", engine: null, reason: "the engine answered 500" },
    ]);
    hotStandby.on = false;
    await fake.instance.tick();
    expect(fake.instance.view().standbys).toEqual([]);
  });

  test("gives a short phrase when a standby can't start, not the error with its address", async () => {
    const hotStandby = { on: false };
    const failEngineStarts = { on: false };
    const fake = await withStandby({ hotStandby, failEngineStarts, standbyData: new Set() });
    failEngineStarts.on = true;
    hotStandby.on = true;
    await fake.instance.tick();
    await settle();
    expect(fake.instance.view().standbys).toMatchObject([
      { path: "wg:a", state: "failed", engine: null, reason: "could not start its engine or session" },
    ]);
  });

  test("lists no path that failed standbys once the stream may no longer use the path", async () => {
    const allowed = { vpn: true };
    const pathAllowed = (path: string): boolean => path !== "wg:a" || allowed.vpn;
    const fake = await withStandby({ standbyData: new Set(), pathAllowed });
    for (let tick = 0; tick < 200 && fake.removed.length === 0; tick += 1) {
      fake.clock.now += 5000;
      await fake.instance.tick();
      await settle();
    }
    expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a", state: "failed" }]);
    allowed.vpn = false;
    await fake.instance.tick();
    expect(fake.instance.view().standbys).toEqual([]);
  });

  test("lists a path that waits for a standby only within the number of standbys it keeps", async () => {
    const fake = await withStandby({ standbyData: new Set(), standby: { maxPaths: 1 } }, [direct, vpn, vpnB]);
    for (let tick = 0; tick < 200 && fake.removed.length === 0; tick += 1) {
      fake.clock.now += 5000;
      await fake.instance.tick();
      await settle();
    }
    // The only slot went to the other path, which gets the standby now; the first waits behind it.
    await fake.instance.tick();
    await settle();
    expect(fake.instance.view().standbys.map(({ path }) => path)).toEqual(["wg:b"]);
  });

  test("forgets the failed rounds of a path the stream moves to", async () => {
    const fake = await withStandby({ standbyData: new Set() });
    for (let tick = 0; tick < 200 && fake.removed.length === 0; tick += 1) {
      fake.clock.now += 5000;
      await fake.instance.tick();
      await settle();
    }
    // The path gets a new standby after its wait, and the stream moves to that one.
    for (let tick = 0; tick < 200 && fake.creates() < 3; tick += 1) {
      fake.clock.now += 5000;
      await fake.instance.tick();
      await settle();
    }
    expect(fake.creates()).toBe(3);
    fake.sources.add(play(own(3)));
    fake.sources.delete(play(main));
    fake.paths[0] = { ...direct, up: false };
    fake.clock.now += settings.stallAfterMs + 1000;
    await fake.instance.tick();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view().standbys.map(({ path }) => path)).not.toContain("wg:a");
  });

  test("removes its standbys once the stream hasn't played for a while, and starts none", async () => {
    const fake = await withStandby({ standbyData: new Set() });
    fake.sources.clear();
    for (let tick = 0; tick < 90; tick += 1) {
      fake.clock.now += 10_000;
      await fake.instance.tick();
      await settle();
      if (tick === 80) {
        expect(fake.instance.view().standbys).toEqual([]);
        expect(fake.removed).toContain(standbyEngine.containerId);
      }
    }
    // Meanwhile the recovery ladder goes on, but the stream keeps no standby.
    expect(fake.instance.view().standbys).toEqual([]);
    expect(fake.readers.at(-1)).toEqual([]);
  });

  test("moves to the standby once WireGuard only is on, and removes the engine it left", async () => {
    const policy = { wireguardOnly: false };
    const pathAllowed = (path: string): boolean => !policy.wireguardOnly || path !== "direct";
    const fake = await withStandby({ pathAllowed });
    policy.wireguardOnly = true;
    await fake.instance.tick();
    await settle();
    expect(fake.instance.path).toBe("wg:a");
    expect(fake.instance.view()).toMatchObject({ engine: { name: standbyEngine.name }, recoveries: 0 });
    expect(fake.creates()).toBe(2);
    expect(fake.removed).toEqual([main.containerId]);
    expect(fake.instance.view().standbys).toEqual([]);
    expect(fake.instance.assignments()).toEqual([{ ip: standbyEngine.ip, path: "wg:a" }]);
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
        rejoin: (handle: EngineHandle, _stream: string, role = "play") => {
          calls.push(`rejoin ${handle.sharedPath ?? "?"} as ${role}`);
          return Promise.resolve(handle);
        },
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
        { path: "wg:a", state: "hot", engine: { name: onVpn.name, shared: true }, reason: null },
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

    test("a standby session that brings no data checks its shared engine before it opens again", async () => {
      const pool = sharedEngines();
      const sources = new Set([play(onDirect), play(onVpn)]);
      const fake = await withStandby({ shared: pool.shared, sharing: { on: true }, sources, standbyData: new Set() });
      for (let tick = 0; tick < 40 && !pool.calls.includes("rejoin wg:a as standby"); tick += 1) {
        fake.clock.now += 5000;
        await fake.instance.tick();
        await settle();
      }
      // Maybe no stream plays from that engine, and then nothing else would notice that it stopped.
      expect(pool.calls).toEqual(["acquire direct as play", "acquire wg:a as standby", "rejoin wg:a as standby"]);
      expect(fake.instance.view().standbys).toMatchObject([{ path: "wg:a", engine: { name: onVpn.name } }]);
      expect(fake.creates()).toBe(0);
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
        { path: "wg:a", state: "hot", engine: { name: onVpn.name, shared: true }, reason: null },
      ]);
      expect(fake.instance.assignments()).toEqual([]);
    });
  });
});

describe("the figures of a stream during a long step", () => {
  const vpn: PathStatus = { ...direct, id: "wg:a", kind: "wireguard", label: "VPN", score: 0.5 };
  const replacement: EngineHandle = {
    ...engine,
    containerId: "c2",
    name: "aceswarm-engine-s1-2",
    generation: 2,
    ip: "172.31.250.11",
    baseUrl: "http://172.31.250.11:6878",
  };
  const oldStat = `${engine.baseUrl}/stat`;
  /** Peers of the engine the stream plays from and of the one it moves to. */
  const peersOf = (peers: { value: number }) => (statUrl: string) => (statUrl === oldStat ? peers.value : 2);

  /** A stream that plays from its own engine on the direct path, until the policy turns that path off. */
  async function playing() {
    const { state, pathAllowed } = policy(false);
    const hold: Hold = {};
    const peers = { value: 5 };
    const fake = supervisor([direct, vpn], {
      created: [engine, replacement],
      video: { on: true },
      handover: "delivers",
      pathAllowed,
      hold,
      peersOf: peersOf(peers),
    });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", lastFrameAt: iso(fake.clock.now) });
    /** Turns the direct path off: the move to the VPN waits for the new engine's session until `open`. */
    const move = async () => {
      const gate = latch();
      hold.session = gate.promise;
      state.on = true;
      const step = fake.instance.tick();
      await settle();
      return { step, open: gate.open };
    };
    return { ...fake, hold, peers, move };
  }

  test("a playing stream keeps its video time, peers and speed while it moves to another engine", async () => {
    const fake = await playing();
    const before = fake.clock.now;
    const moving = await fake.move();
    fake.clock.now += 40_000;
    fake.peers.value = 7;
    // No check ran for 40 s, so far: the old engine delivers all the while.
    expect(fake.instance.view()).toMatchObject({ lastFrameAt: iso(before), peers: { connected: 5 } });

    await fake.instance.observe();
    expect(fake.instance.view()).toMatchObject({ state: "switching", lastFrameAt: iso(fake.clock.now) });
    expect(fake.instance.view().peers.connected).toBe(7);

    moving.open();
    await moving.step;
    expect(fake.instance.path).toBe("wg:a");
  });

  test("shows no peers once the stream moved, until the new engine's are polled", async () => {
    const fake = await playing();
    const moving = await fake.move();
    moving.open();
    await moving.step;
    // The old engine's are gone, and the commit doesn't wait to poll the new one.
    expect(fake.instance.view().peers.connected).toBeNull();
    await fake.instance.observe();
    expect(fake.instance.view().peers.connected).toBe(2);
  });

  test("drops what an observation polled from an engine the stream has left", async () => {
    const fake = await playing();
    const moving = await fake.move();
    // The poll of the old engine is on its way when the move finishes.
    const answer = latch();
    fake.hold.stats = new Map([[oldStat, answer.promise]]);
    fake.peers.value = 9;
    fake.clock.now += 5000;
    const observing = fake.instance.observe();
    await settle();

    moving.open();
    await moving.step;
    expect(fake.instance.view().peers.connected).toBeNull();
    answer.open();
    await observing;
    // What it polled from the old engine does not come back.
    expect(fake.instance.view().peers.connected).toBeNull();
    await fake.instance.observe();
    expect(fake.instance.view().peers.connected).toBe(2);
  });

  test("shows no peers or speed once its session ended, until a new session is polled", async () => {
    const hold: Hold = {};
    const fake = supervisor([direct], { video: { on: true }, hold, peersOf: () => 5 });
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view().peers.connected).toBe(5);

    // The restart stops its session, and the engine refuses a new one.
    const refused = Promise.reject(new Error("engine said no"));
    refused.catch(() => undefined);
    hold.session = refused;
    fake.instance.requestRestart();
    await fake.instance.tick();
    const gone = { peers: { connected: null, active: null, uploading: null, countries: [] }, downloadKBps: null };
    expect(fake.instance.view()).toMatchObject({ state: "stalled", ...gone, uploadKBps: null });

    // Every later check only tries to start it again.
    fake.clock.now += settings.recoveryMaxDelayMs;
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "error", ...gone });

    hold.session = undefined;
    fake.clock.now += settings.recoveryMaxDelayMs;
    await fake.instance.tick();
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "playing", peers: { connected: 5 } });
  });

  test("a failing check of the standbys does not hold up the start of a stream without a session", async () => {
    vi.spyOn(StreamStandbys.prototype, "maintain").mockRejectedValue(new Error("the standbys broke"));
    const fake = supervisor([direct], { video: { on: true } });
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "starting", message: "opening stream" });
  });

  test("keeps polling while it waits for a network path", async () => {
    const paths: PathStatus[] = [];
    const peers = { value: 3 };
    const fake = supervisor(paths, { peersOf: () => peers.value });
    // The gateway's paths are unknown: the engine starts without one, and its session opens.
    await fake.instance.tick();
    paths.push({ ...direct, up: false });
    await fake.instance.tick();
    expect(fake.instance.view()).toMatchObject({ state: "stalled", peers: { connected: 3 } });
    peers.value = 4;
    await fake.instance.tick();
    expect(fake.instance.view().peers.connected).toBe(4);
  });
});

describe("the timer that observes a long step", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("brings the view up to date while a step waits, and not before the step took a tick", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { state, pathAllowed } = policy(false);
    const hold: Hold = {};
    const vpn: PathStatus = { ...direct, id: "wg:a", kind: "wireguard", label: "VPN", score: 0.5 };
    const next: EngineHandle = { ...engine, containerId: "c2", generation: 2, ip: "172.31.250.11" };
    const fake = supervisor([direct, vpn], { created: [engine, next], video: { on: true }, pathAllowed, hold });
    fake.instance.start();
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(tick === 0 ? 0 : settings.tickMs);
      fake.clock.now += settings.tickMs;
    }
    expect(fake.instance.view()).toMatchObject({ state: "playing" });

    // The step that moves the stream waits for the new engine's session.
    hold.session = latch().promise;
    state.on = true;
    await vi.advanceTimersByTimeAsync(settings.tickMs);
    const polled = fake.clock.now;
    expect(fake.instance.view()).toMatchObject({ state: "switching", lastFrameAt: iso(polled) });

    // Less than a tick into the step, nothing is observed.
    fake.clock.now += settings.tickMs / 2;
    await vi.advanceTimersByTimeAsync(settings.tickMs);
    expect(fake.instance.view().lastFrameAt).toBe(iso(polled));

    fake.clock.now += 30_000;
    await vi.advanceTimersByTimeAsync(settings.tickMs);
    expect(fake.instance.view().lastFrameAt).toBe(iso(fake.clock.now));

    vi.useRealTimers();
    await fake.instance.stop(false, 0);
  });

  test("stops observing when the stream stops, whatever step is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { state, pathAllowed } = policy(false);
    const hold: Hold = {};
    const polls = { count: 0 };
    const peersOf = () => {
      polls.count += 1;
      return 2;
    };
    const vpn: PathStatus = { ...direct, id: "wg:a", kind: "wireguard", label: "VPN", score: 0.5 };
    const next: EngineHandle = { ...engine, containerId: "c2", generation: 2, ip: "172.31.250.11" };
    const fake = supervisor([direct, vpn], {
      created: [engine, next],
      video: { on: true },
      pathAllowed,
      hold,
      peersOf,
    });
    fake.instance.start();
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(tick === 0 ? 0 : settings.tickMs);
      fake.clock.now += settings.tickMs;
    }
    const session = latch();
    hold.session = session.promise;
    state.on = true;
    await vi.advanceTimersByTimeAsync(settings.tickMs);
    fake.clock.now += 30_000;
    const before = polls.count;
    await vi.advanceTimersByTimeAsync(settings.tickMs);
    const observed = polls.count;
    expect(observed).toBeGreaterThan(before);

    // The step goes on, but nobody follows the stream any more: the timer is gone.
    const stopping = fake.instance.stop(false, 0);
    fake.clock.now += 30_000;
    await vi.advanceTimersByTimeAsync(10 * settings.tickMs);
    expect(polls.count).toBe(observed);

    session.open();
    vi.useRealTimers();
    await stopping;
  });
});
