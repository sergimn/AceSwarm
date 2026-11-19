import { mkdtemp, open, rm } from "node:fs/promises";
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
import { Orchestrator, type OrchestratorDeps } from "../src/orchestrator.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { SharedEngines } from "../src/shared-engines.ts";
import { StreamStore } from "../src/stream-store.ts";
import { Viewers } from "../src/viewers.ts";
import { WireguardStore } from "../src/wireguard-store.ts";

const ACE_ID = "6d325cda6ed591647ef5e91edd043147bce8be30";

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
  // Every store write flushes its file to the disk, which takes as long as the disk does: seconds
  // on a slow one, and these tests make a dozen writes and wait for them. They don't test the flush
  // (json-file.test.ts does), so it is skipped here.
  const probe = await open(import.meta.filename, "r");
  const handles = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const skipFlush = vi.spyOn(handles, "sync").mockImplementation(() => Promise.resolve());
  onTestFinished(() => {
    skipFlush.mockRestore();
  });
  /** What the fakes were asked to do, in order. */
  const events: string[] = [];
  /** Promises the fakes wait for before they answer, set by a test to hold something up. */
  const holds: { teardown?: Promise<void>; stats?: Promise<void> | undefined } = {};
  /** The streams to keep, as `removeOrphans` was asked on each start. */
  const orphanChecks: string[][] = [];
  const dataDir = await mkdtemp(join(tmpdir(), "aceswarm-orchestrator-"));
  const started: Orchestrator[] = [];
  // The orchestrators stop before their directory goes: stopping saves to it.
  onTestFinished(async () => {
    for (const orchestrator of started) {
      await orchestrator.stop();
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const pipelines = new Map<string, PipelineStatus>();
  /** The last frame time the transcoder reported for each stream. */
  const reported = new Map<string, string>();
  const transcoder = {
    start: (id: string, input: { source: string }) => {
      events.push(`start pipeline ${id}`);
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
        layout: null,
        layoutChangedAt: null,
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
    stop: async (id: string) => {
      events.push(`stop pipeline ${id}`);
      await holds.teardown;
      pipelines.delete(id);
    },
    setStandbys: () => Promise.resolve(undefined),
  } as unknown as TranscoderClient;
  const engines = {
    ensureImage: () => Promise.resolve(),
    removeOrphans: (keep: ReadonlySet<string>) => {
      orphanChecks.push([...keep]);
      return Promise.resolve(0);
    },
    find: () => Promise.resolve([]),
    removeAllFor: (streamId: string) => {
      events.push(`remove engines ${streamId}`);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
    create: async (streamId: string, generation: number, onAddress?: OnEngineAddress) => {
      events.push(`create engine ${streamId}`);
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
    stats: async () => {
      if (holds.stats !== undefined) {
        events.push("stats held");
      }
      await holds.stats;
      return { status: "dl", peers: 3, speedDown: 400, speedUp: 0, downloaded: 0, uploaded: 0 };
    },
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
  const start = async (
    options: Pick<OrchestratorDeps, "thumbnailsOnly"> = {},
  ): Promise<{ orchestrator: Orchestrator; store: StreamStore }> => {
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
      stopWaitMs: 500,
      ...options,
    });
    started.push(orchestrator);
    await orchestrator.start();
    return { orchestrator, store };
  };
  return { start, pipelines, reported, events, holds, orphanChecks };
}

test("tells every screen whether the admin allows thumbnails only in the tiles", async () => {
  const { start } = await harness();
  const { orchestrator } = await start();
  expect(orchestrator.snapshot().tilePreviews).toEqual({ thumbnailsOnly: false });
  await orchestrator.stop();
  const restricted = await start({ thumbnailsOnly: true });
  expect(restricted.orchestrator.snapshot().tilePreviews).toEqual({ thumbnailsOnly: true });
});

test("a disabled stream says when it last had video, is on no path and can't be restarted", async () => {
  const { start, pipelines, reported } = await harness();
  const { orchestrator } = await start();
  const added = await orchestrator.addStream({ aceId: ACE_ID, name: "One" });
  await vi.waitFor(() => {
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
  // the last frame time its pipeline ever reported.
  await vi.waitFor(() => {
    expect(pipelines.has(added.id)).toBe(false);
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
  await vi.waitFor(() => {
    const now = restarted.orchestrator.getStream(added.id);
    expect(now).toMatchObject({ state: "playing", path: "direct" });
    expect(Date.parse(now?.lastFrameAt ?? "")).toBeGreaterThan(Date.parse(stopped ?? ""));
  });
});

test("a stream that never had video has no last frame time, also once it is disabled", async () => {
  const { start, pipelines } = await harness(false);
  const { orchestrator, store } = await start();
  const added = await orchestrator.addStream({ aceId: ACE_ID });
  await vi.waitFor(() => {
    expect(store.get(added.id)?.session).not.toBeNull();
  });
  expect(orchestrator.getStream(added.id)).toMatchObject({ state: "starting", lastFrameAt: null });

  const disabled = await orchestrator.updateStream(added.id, { enabled: false });
  expect(disabled).toMatchObject({ state: "stopped", lastFrameAt: null, path: null });
  await vi.waitFor(() => {
    expect(pipelines.has(added.id)).toBe(false);
    expect(store.get(added.id)?.session).toBeNull();
  });
  expect(orchestrator.getStream(added.id)?.lastFrameAt).toBeNull();
});

/** The stream added and playing, with the events of getting there forgotten. */
async function playingStream(setup: Awaited<ReturnType<typeof harness>>) {
  const { orchestrator, store } = await setup.start();
  const added = await orchestrator.addStream({ aceId: ACE_ID });
  await vi.waitFor(() => {
    expect(orchestrator.getStream(added.id)).toMatchObject({ state: "playing", path: "direct" });
  });
  setup.events.length = 0;
  return { orchestrator, store, id: added.id };
}

const waitingMessage = "waiting for the previous run to stop";

test("a stream enabled while its previous run is still being torn down starts behind it", async () => {
  const setup = await harness();
  const { orchestrator, id } = await playingStream(setup);
  const { events, holds } = setup;

  // The teardown is held up, as one is behind a step in progress when the stream was disabled.
  const teardown = Promise.withResolvers<undefined>();
  holds.teardown = teardown.promise;
  await orchestrator.updateStream(id, { enabled: false });
  await vi.waitFor(() => {
    expect(events).toContain(`stop pipeline ${id}`);
  });

  // Enabled again before it ended: it says what it waits for, and starts nothing meanwhile.
  const enabled = await orchestrator.updateStream(id, { enabled: true });
  expect(enabled).toMatchObject({ enabled: true, state: "starting", message: waitingMessage, engine: null });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(orchestrator.getStream(id)).toMatchObject({ state: "starting", message: waitingMessage });
  expect(events).toEqual([`stop pipeline ${id}`]);

  // Once the old run is gone, the new one starts its own engine and pipeline, and plays without a
  // recovery: nothing of the old one is taken over, and nothing of the new one is removed.
  teardown.resolve(undefined);
  await vi.waitFor(() => {
    expect(orchestrator.getStream(id)).toMatchObject({ state: "playing", path: "direct", recoveries: 0 });
  });
  expect(events).toEqual([
    `stop pipeline ${id}`,
    `remove engines ${id}`,
    `create engine ${id}`,
    `start pipeline ${id}`,
  ]);
});

test("a stream enabled and disabled again while it waits for its previous run is torn down after it", async () => {
  const setup = await harness();
  const { orchestrator, id } = await playingStream(setup);
  const { events, holds } = setup;
  const teardown = Promise.withResolvers<undefined>();
  holds.teardown = teardown.promise;
  await orchestrator.updateStream(id, { enabled: false });
  await vi.waitFor(() => {
    expect(events).toContain(`stop pipeline ${id}`);
  });

  await orchestrator.updateStream(id, { enabled: true });
  const disabled = await orchestrator.updateStream(id, { enabled: false });
  expect(disabled).toMatchObject({ enabled: false, state: "stopped" });
  teardown.resolve(undefined);

  // Nothing started in between, and the second teardown, which has nothing to remove, also ran.
  await vi.waitFor(() => {
    expect(events.filter((event) => event === `stop pipeline ${id}`)).toHaveLength(2);
  });
  expect(events.filter((event) => event.startsWith("create") || event.startsWith("start"))).toEqual([]);
  expect(orchestrator.getStream(id)).toMatchObject({ enabled: false, state: "stopped" });
  expect(orchestrator.runningSince(id)).toBeUndefined();
});

test("a stream disabled again while it waits keeps the last video time its previous run saved", async () => {
  const setup = await harness();
  const { orchestrator, store, id } = await playingStream(setup);
  const { events, holds } = setup;

  // A step of the run is in progress when the stream is disabled and enabled again.
  const step = Promise.withResolvers<undefined>();
  holds.stats = step.promise;
  await vi.waitFor(() => {
    expect(events).toContain("stats held");
  });
  await orchestrator.updateStream(id, { enabled: false });
  await orchestrator.updateStream(id, { enabled: true });
  const known = store.get(id)?.lastFrameAt ?? "";

  // The step ends and the run saves the last video it saw, then its teardown is held up.
  const teardown = Promise.withResolvers<undefined>();
  holds.teardown = teardown.promise;
  holds.stats = undefined;
  step.resolve(undefined);
  await vi.waitFor(() => {
    expect(events).toContain(`stop pipeline ${id}`);
  });
  const saved = store.get(id)?.lastFrameAt ?? "";
  expect(Date.parse(saved)).toBeGreaterThan(Date.parse(known));

  // The new run never started, so it knows of no newer video than it was created with: disabling
  // it again must not set the time back.
  await orchestrator.updateStream(id, { enabled: false });
  expect(store.get(id)?.lastFrameAt).toBe(saved);
  teardown.resolve(undefined);
});

test("a removed stream's engines are removed after its teardown in progress", async () => {
  const setup = await harness();
  const { orchestrator, id } = await playingStream(setup);
  const { events, holds } = setup;
  const teardown = Promise.withResolvers<undefined>();
  holds.teardown = teardown.promise;
  await orchestrator.updateStream(id, { enabled: false });
  await vi.waitFor(() => {
    expect(events).toContain(`stop pipeline ${id}`);
  });

  expect(await orchestrator.removeStream(id)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events).toEqual([`stop pipeline ${id}`]);
  teardown.resolve(undefined);
  await vi.waitFor(() => {
    expect(events).toEqual([`stop pipeline ${id}`, `remove engines ${id}`, `remove engines ${id}`]);
  });
});

test("shutting down waits a moment for a teardown in progress, not for ever", async () => {
  const setup = await harness();
  const { orchestrator, id } = await playingStream(setup);
  const { events, holds } = setup;
  const teardown = Promise.withResolvers<undefined>();
  holds.teardown = teardown.promise;
  await orchestrator.updateStream(id, { enabled: false });
  await vi.waitFor(() => {
    expect(events).toContain(`stop pipeline ${id}`);
  });

  // One that ends in time is waited for.
  setTimeout(() => {
    teardown.resolve(undefined);
  }, 50);
  await orchestrator.stop();
  expect(events).toContain(`remove engines ${id}`);

  // One that doesn't is not (the harness stops waiting after half a second).
  const stuck = Promise.withResolvers<undefined>();
  holds.teardown = stuck.promise;
  const { orchestrator: restarted } = await setup.start();
  await restarted.updateStream(id, { enabled: true });
  await vi.waitFor(() => {
    expect(restarted.getStream(id)).toMatchObject({ state: "playing" });
  });
  await restarted.updateStream(id, { enabled: false });
  const started = Date.now();
  await restarted.stop();
  expect(Date.now() - started).toBeLessThan(2000);
  stuck.resolve(undefined);
});

test("a list of streams is added together: the new ones start unless they are added disabled", async () => {
  const { start, events } = await harness();
  const { orchestrator } = await start();
  const known = await orchestrator.addStream({ aceId: ACE_ID, name: "One" });
  await vi.waitFor(() => {
    expect(orchestrator.getStream(known.id)).toMatchObject({ state: "playing" });
  });
  events.length = 0;

  const outcomes = await orchestrator.addStreams([
    { aceId: "b".repeat(40) },
    { aceId: ACE_ID, name: "Again" },
    { aceId: "c".repeat(40), enabled: false },
  ]);
  expect(outcomes.map((outcome) => outcome.added)).toEqual([true, false, true]);
  const [started, same, waiting] = outcomes.map((outcome) => outcome.stream);
  // The stream that was there is answered as it is, and keeps playing.
  expect(same).toMatchObject({ id: known.id, name: "One", state: "playing" });
  expect(waiting).toMatchObject({ enabled: false, state: "stopped", path: null, engine: null });

  await vi.waitFor(() => {
    expect(orchestrator.getStream(started?.id ?? "")).toMatchObject({ state: "playing", path: "direct" });
  });
  // Only the enabled new stream got an engine: not the disabled one, and no second one for the first.
  expect(events.filter((event) => event.startsWith("create engine"))).toEqual([`create engine ${started?.id ?? ""}`]);
  expect(orchestrator.runningSince(waiting?.id ?? "")).toBeUndefined();
  expect(orchestrator.snapshot().streams.map((stream) => stream.aceId)).toEqual([
    ACE_ID,
    "b".repeat(40),
    "c".repeat(40),
  ]);

  // The disabled one starts once it is enabled, as any disabled stream does.
  await orchestrator.updateStream(waiting?.id ?? "", { enabled: true });
  await vi.waitFor(() => {
    expect(orchestrator.getStream(waiting?.id ?? "")).toMatchObject({ state: "playing" });
  });
});

test("a starting controller removes the engines of disabled streams as well as deleted ones", async () => {
  const setup = await harness();
  const { orchestrator } = await setup.start();
  const one = await orchestrator.addStream({ aceId: ACE_ID, name: "One" });
  const two = await orchestrator.addStream({ aceId: "b".repeat(40), name: "Two" });
  await orchestrator.updateStream(two.id, { enabled: false });
  await orchestrator.stop();

  setup.orphanChecks.length = 0;
  await setup.start();
  expect(setup.orphanChecks).toEqual([[one.id]]);
});
