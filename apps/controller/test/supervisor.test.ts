import { Registry } from "@prometheus-io/client";
import type { PathAssignment, PathStatus, PipelineStatus } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { expect, test } from "vitest";
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
  pathHysteresis: 0.15,
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
}

/** A supervisor whose dependencies are fakes; `paths` is what the gateway reports. */
function supervisor(paths: PathStatus[], fakes: Fakes = {}) {
  const assigned: PathAssignment[] = [];
  const unassigned: string[] = [];
  const clock = { now: 1000 };
  const created = [...(fakes.created ?? [engine])];
  // The gateway assignments as they were each time an engine's API first answered.
  const assignedWhenReady: PathAssignment[][] = [];
  const engines = {
    find: () => Promise.resolve([]),
    create: async (_streamId: string, _generation: number, onAddress?: OnEngineAddress) => {
      const handle = (created.length > 1 ? created.shift() : created[0]) ?? engine;
      await onAddress?.(handle);
      assignedWhenReady.push([...assigned]);
      return handle;
    },
  } as unknown as EngineManager;
  let sessions = 0;
  const ace = {
    startSession: () => {
      sessions += 1;
      return fakes.failFirstSession === true && sessions === 1
        ? Promise.reject(new Error("engine died"))
        : Promise.resolve(session);
    },
    stats: () => Promise.resolve({ status: "dl", peers: 1, speedDown: 0, speedUp: 0, downloaded: 0, uploaded: 0 }),
  } as unknown as AcestreamClient;
  const transcoder = {
    start: () => Promise.resolve(pipeline),
    status: () => Promise.resolve(pipeline),
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
    pathLoad: () => new Map(),
    now: () => clock.now,
  });
  return { instance, assigned, assignedWhenReady, unassigned, clock };
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
