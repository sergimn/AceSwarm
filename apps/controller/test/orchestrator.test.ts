import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "@prometheus-io/client";
import type { PathStatus, PipelineStatus } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { expect, onTestFinished, test, vi } from "vitest";
import type { AcestreamClient } from "../src/acestream.ts";
import type { NetgwClient, TranscoderClient } from "../src/clients.ts";
import type { EngineHandle, EngineManager, OnEngineAddress } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import { NetworkPolicyStore } from "../src/network-policy-store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { SharedEngines } from "../src/shared-engines.ts";
import { StreamStore } from "../src/stream-store.ts";
import { Viewers } from "../src/viewers.ts";
import { WireguardStore } from "../src/wireguard-store.ts";

const ACE_ID = "6d325cda6ed591647ef5e91edd043147bce8be30";

/**
 * These tests use real stores, and every store write flushes its file to the disk: a stream that
 * starts takes five or six, so what the tests wait for takes as long as the disk does, which is
 * seconds on a slow one. Their waits and the tests themselves get limits that only a hang reaches.
 */
const WAIT_MS = 20_000;
const SLOW_DISK = { timeout: 60_000 };

/** `vi.waitFor` that allows for a slow disk. */
async function waitFor(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: WAIT_MS });
}

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
  ip: "172.31.250.130",
  baseUrl: "http://172.31.250.130:6878",
  sharedPath: null,
};

/**
 * Orchestrators with real stores in one temporary data directory and fakes for everything they
 * talk to: engines that start at once, and a transcoder whose pipelines have video from the moment
 * they start (or never, without `video`). `start()` gives a new one, as a controller restart does.
 */
async function harness(video = true) {
  const dataDir = await mkdtemp(join(tmpdir(), "aceswarm-orchestrator-"));
  const started: Orchestrator[] = [];
  // The orchestrators stop before their directory goes: stopping saves to it.
  onTestFinished(async () => {
    for (const orchestrator of started) {
      await orchestrator.stop();
    }
    await rm(dataDir, { recursive: true, force: true });
  }, SLOW_DISK.timeout);
  const pipelines = new Map<string, PipelineStatus>();
  /** The last frame time the transcoder reported for each stream. */
  const reported = new Map<string, string>();
  const transcoder = {
    start: (id: string, input: { source: string }) => {
      const pipeline: PipelineStatus = {
        id,
        state: "running",
        source: input.source,
        startedAt: new Date().toISOString(),
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
      pipelines.set(id, pipeline);
      return Promise.resolve(pipeline);
    },
    status: (id: string) => {
      const pipeline = pipelines.get(id);
      if (pipeline === undefined || !video) {
        return Promise.resolve(pipeline);
      }
      const lastFrameAt = new Date().toISOString();
      reported.set(id, lastFrameAt);
      return Promise.resolve({ ...pipeline, lastFrameAt });
    },
    stop: (id: string) => {
      pipelines.delete(id);
      return Promise.resolve();
    },
    setStandbys: () => Promise.resolve(undefined),
  } as unknown as TranscoderClient;
  const engines = {
    ensureImage: () => Promise.resolve(),
    removeOrphans: () => Promise.resolve(0),
    find: () => Promise.resolve([]),
    removeAllFor: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    create: async (streamId: string, generation: number, onAddress?: OnEngineAddress) => {
      const handle = { ...engine, streamId, generation };
      await onAddress?.(handle);
      return handle;
    },
    ownName: (streamId: string, generation: number) => `aceswarm-engine-${streamId}-${String(generation)}`,
  } as unknown as EngineManager;
  const ace = {
    startSession: (baseUrl: string) =>
      Promise.resolve({ playbackUrl: `${baseUrl}/play`, statUrl: `${baseUrl}/stat`, commandUrl: `${baseUrl}/cmd` }),
    stopSession: () => Promise.resolve(),
    stats: () => Promise.resolve({ status: "dl", peers: 3, speedDown: 400, speedUp: 0, downloaded: 0, uploaded: 0 }),
  } as unknown as AcestreamClient;
  const netgw = {
    paths: () => Promise.resolve([direct]),
    assign: () => Promise.resolve(),
    unassign: () => Promise.resolve(),
    sync: () => Promise.resolve([]),
    reload: () => Promise.resolve(),
    peers: () => Promise.reject(new Error("no peers")),
  } as unknown as NetgwClient;
  const metrics = new ControllerMetrics(new Registry(), () => ({ streams: [], paths: [] }));
  const logger = createLogger("test", "silent");
  const start = async (): Promise<{ orchestrator: Orchestrator; store: StreamStore }> => {
    const wireguard = new WireguardStore(dataDir);
    const store = new StreamStore(dataDir);
    const orchestrator = new Orchestrator({
      store,
      wireguard,
      policy: new NetworkPolicyStore(wireguard.directory),
      settingsStore: new SettingsStore(dataDir),
      shared: new SharedEngines({
        engines,
        netgw,
        metrics,
        logger,
        settings: { maxFailures: 2, failureWindowMs: 60_000, retireTimeoutMs: 60_000, idleTimeoutMs: 30_000 },
      }),
      viewers: new Viewers({ pingMs: 60_000 }),
      engines,
      ace,
      transcoder,
      netgw,
      metrics,
      logger,
      settings: {
        tickMs: 5,
        stallAfterMs: 20_000,
        startupGraceMs: 60_000,
        recoveryBaseDelayMs: 1000,
        recoveryMaxDelayMs: 60_000,
        handoverTimeoutMs: 30_000,
        pathStrategy: "sticky-best",
        pathMinDwellMs: 300_000,
      },
      // However long a step takes on a slow disk, `stop()` waits for it: a step left running would
      // keep writing to the stream list after `stop()` returned, while the next orchestrator or the
      // removal of the directory is under way.
      stopWaitMs: Infinity,
    });
    started.push(orchestrator);
    await orchestrator.start();
    return { orchestrator, store };
  };
  return { start, pipelines, reported };
}

test("a disabled stream says when it last had video, is on no path and can't be restarted", SLOW_DISK, async () => {
  const { start, pipelines, reported } = await harness();
  const { orchestrator, store } = await start();
  const added = await orchestrator.addStream({ aceId: ACE_ID, name: "One" });
  await waitFor(() => {
    expect(orchestrator.getStream(added.id)).toMatchObject({ state: "playing", path: "direct" });
  });
  const playing = orchestrator.getStream(added.id);
  expect(playing?.lastFrameAt).toEqual(expect.any(String));
  const playedAt = Date.parse(playing?.lastFrameAt ?? "");

  // The answer to the change itself already has it, not only a later snapshot.
  const disabled = await orchestrator.updateStream(added.id, { enabled: false });
  expect(disabled).toMatchObject({ enabled: false, state: "stopped", path: null, engine: null });
  expect(Date.parse(disabled?.lastFrameAt ?? "")).toBeGreaterThanOrEqual(playedAt);
  expect(orchestrator.restartStream(added.id)).toBe(false);
  expect(orchestrator.runningSince(added.id)).toBeUndefined();

  // The frames that came between the last check and the stop count too: the stream ends up with
  // the last frame time its pipeline ever reported. It has stopped once its pipeline is gone and
  // its session forgotten, the last thing it saves: until then it writes to the stream list, which
  // the restarted controller below shares.
  await waitFor(() => {
    expect(pipelines.has(added.id)).toBe(false);
    expect(store.get(added.id)?.session).toBeNull();
    expect(orchestrator.getStream(added.id)?.lastFrameAt).toBe(reported.get(added.id));
  });
  const stopped = reported.get(added.id);
  expect(orchestrator.snapshot().streams).toMatchObject([{ id: added.id, state: "stopped", lastFrameAt: stopped }]);

  // A restarted controller reads it from the stream list.
  await orchestrator.stop();
  const restarted = await start();
  expect(restarted.orchestrator.getStream(added.id)).toMatchObject({
    enabled: false,
    state: "stopped",
    lastFrameAt: stopped,
    path: null,
  });

  // Enabled again, it shows that time until its new pipeline has video. It is from before this run.
  expect(restarted.orchestrator.runningSince(added.id)).toBeUndefined();
  const enabled = await restarted.orchestrator.updateStream(added.id, { enabled: true });
  expect(enabled).toMatchObject({ enabled: true, lastFrameAt: stopped });
  expect(restarted.orchestrator.runningSince(added.id)).toBeGreaterThanOrEqual(Date.parse(stopped ?? ""));
  await waitFor(() => {
    const now = restarted.orchestrator.getStream(added.id);
    expect(now).toMatchObject({ state: "playing", path: "direct" });
    expect(Date.parse(now?.lastFrameAt ?? "")).toBeGreaterThan(Date.parse(stopped ?? ""));
  });
});

test("a stream that never had video has no last frame time, also once it is disabled", SLOW_DISK, async () => {
  const { start, pipelines } = await harness(false);
  const { orchestrator, store } = await start();
  const added = await orchestrator.addStream({ aceId: ACE_ID });
  await waitFor(() => {
    expect(store.get(added.id)?.session).not.toBeNull();
  });
  expect(orchestrator.getStream(added.id)).toMatchObject({ state: "starting", lastFrameAt: null });

  const disabled = await orchestrator.updateStream(added.id, { enabled: false });
  expect(disabled).toMatchObject({ state: "stopped", lastFrameAt: null, path: null });
  await waitFor(() => {
    expect(pipelines.has(added.id)).toBe(false);
    expect(store.get(added.id)?.session).toBeNull();
  });
  expect(orchestrator.getStream(added.id)?.lastFrameAt).toBeNull();
});
