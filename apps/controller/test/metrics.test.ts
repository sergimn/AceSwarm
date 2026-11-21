import { Registry } from "@prometheus-io/client";
import type { StreamView, ViewerView } from "@aceswarm/shared/api-types";
import { expect, test } from "vitest";
import type { EngineCount, EngineMemory } from "../src/engine-resources.ts";
import { EnginePlaces } from "../src/engine-places.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import type { SharedEngineView } from "../src/shared-engines.ts";

test("every scrape shows the current values, not the previous scrape's", async () => {
  const registry = new Registry();
  let viewers: ViewerView[] = [];
  let shared: SharedEngineView[] = [];
  let engines: EngineCount | undefined;
  new ControllerMetrics(
    registry,
    () => ({ streams: [], paths: [] }),
    () => [],
    { viewers: () => viewers, sharedEngines: () => shared, engines: () => engines },
  );
  expect(await registry.metrics()).not.toContain("aceswarm_viewer_watching{");
  // Before the first sample of the engines, there is no count rather than a wrong one.
  expect(await registry.metrics()).not.toContain("aceswarm_engines{");

  viewers = [{ viewer: "0123456789abcdef", stream: "s1", device: "Chrome on TV", since: "2026-11-05T19:00:00.000Z" }];
  shared = [{ path: "direct", engine: "aceswarm-engine-shared-direct-1", streams: 2, standbys: 0, retiring: false }];
  engines = { own: 3, shared: 0 };
  const scrape = await registry.metrics();
  expect(scrape).toContain('aceswarm_viewer_watching{viewer="0123456789abcdef",device="Chrome on TV",stream="s1"} 1');
  expect(scrape).toContain(
    'aceswarm_shared_engine_streams{path="direct",engine="aceswarm-engine-shared-direct-1",retiring="false"} 2',
  );
  expect(scrape).toContain('aceswarm_engines{kind="own"} 3');
  expect(scrape).toContain('aceswarm_engines{kind="shared"} 0');

  viewers = [];
  engines = { own: 1, shared: 1 };
  const last = await registry.metrics();
  expect(last).not.toContain("aceswarm_viewer_watching{");
  expect(last).toContain('aceswarm_engines{kind="own"} 1');
  expect(last).toContain('aceswarm_engines{kind="shared"} 1');
});

test("exports each engine's estimated cache, its cap when it has one, and peers we upload to", async () => {
  const registry = new Registry();
  const stream: StreamView = {
    id: "s1",
    aceId: "a".repeat(40),
    aceIdKind: "infohash",
    name: "One",
    enabled: true,
    createdAt: "2026-11-06T10:00:00.000Z",
    state: "playing",
    stateSince: "2026-11-06T10:00:00.000Z",
    message: null,
    lastFrameAt: null,
    liveEdge: null,
    peers: { connected: 5, active: 2, uploading: 1, countries: [] },
    downloadKBps: 500,
    uploadKBps: 20,
    path: "direct",
    recoveries: 0,
    viewers: 0,
    hls: { preview: "", full: "", thumbnail: "" },
    engine: { name: "e1", shared: false },
    standbys: [],
  };
  const places = new EnginePlaces(() => []);
  new ControllerMetrics(
    registry,
    () => ({ streams: [stream], paths: [] }),
    () => [
      {
        stream: "s1",
        engine: "e1",
        sharedPath: null,
        usedBytes: 300,
        limitBytes: 512,
        cacheLimitBytes: 128,
        cacheBytes: 128,
      },
      {
        stream: "",
        engine: "e2",
        sharedPath: "wg:a",
        usedBytes: 900,
        limitBytes: 0,
        cacheLimitBytes: null,
        cacheBytes: 700,
      },
    ],
    { enginePlaces: (engines, streams) => places.resolve(engines, streams) },
  );
  const scrape = await registry.metrics();
  expect(scrape).toContain('aceswarm_stream_peers{stream="s1",kind="uploading"} 1');
  // Each engine says what it is for and which path it is on, next to its container's name.
  const own = 'stream="s1",engine="e1",role="playing",path="direct"';
  const shared = 'stream="",engine="e2",role="shared",path="wg:a"';
  expect(scrape).toContain(`aceswarm_engine_memory_bytes{${own}} 300`);
  expect(scrape).toContain(`aceswarm_engine_memory_limit_bytes{${own}} 512`);
  expect(scrape).toContain(`aceswarm_engine_memory_cache_bytes{${own}} 128`);
  expect(scrape).toContain(`aceswarm_engine_memory_cache_limit_bytes{${own}} 128`);
  expect(scrape).toContain(`aceswarm_engine_memory_cache_bytes{${shared}} 700`);
  expect(scrape).not.toContain('aceswarm_engine_memory_cache_limit_bytes{stream="",engine="e2"');
});

/** A reading of an engine of stream s1. */
const sample = (engine: string): EngineMemory => ({
  stream: "s1",
  engine,
  sharedPath: null,
  usedBytes: 300,
  limitBytes: 512,
  cacheLimitBytes: null,
  cacheBytes: 100,
});

test("an engine that replaces another keeps its place's labels, and the one that went is gone at the next scrape", async () => {
  const registry = new Registry();
  const stream = { ...streamOnSharedEngine("s1"), engine: { name: "aceswarm-engine-s1-1", shared: false } };
  let memory = [sample("aceswarm-engine-s1-1")];
  const places = new EnginePlaces(() => []);
  new ControllerMetrics(
    registry,
    () => ({ streams: [stream], paths: [] }),
    () => memory,
    { enginePlaces: (engines, streams) => places.resolve(engines, streams) },
  );
  const place = 'role="playing",path="direct"';
  expect(await registry.metrics()).toContain(
    `aceswarm_engine_memory_bytes{stream="s1",engine="aceswarm-engine-s1-1",${place}} 300`,
  );

  // The stream moved to a new engine on the same path: another container name, the same place.
  stream.engine = { name: "aceswarm-engine-s1-2", shared: false };
  memory = [sample("aceswarm-engine-s1-2")];
  const scrape = await registry.metrics();
  expect(scrape).toContain(`aceswarm_engine_memory_bytes{stream="s1",engine="aceswarm-engine-s1-2",${place}} 300`);
  expect(scrape).not.toContain("aceswarm-engine-s1-1");
});

test("without a source for the engines' places, their role and path are empty", async () => {
  const registry = new Registry();
  new ControllerMetrics(
    registry,
    () => ({ streams: [], paths: [] }),
    () => [
      {
        stream: "s1",
        engine: "e1",
        sharedPath: null,
        usedBytes: 300,
        limitBytes: 512,
        cacheLimitBytes: null,
        cacheBytes: 0,
      },
    ],
  );
  expect(await registry.metrics()).toContain(
    'aceswarm_engine_memory_bytes{stream="s1",engine="e1",role="",path=""} 300',
  );
});

function streamOnSharedEngine(id: string): StreamView {
  return {
    id,
    aceId: "a".repeat(40),
    aceIdKind: "infohash",
    name: id,
    enabled: true,
    createdAt: "2026-11-06T10:00:00.000Z",
    state: "playing",
    stateSince: "2026-11-06T10:00:00.000Z",
    message: null,
    lastFrameAt: null,
    liveEdge: null,
    peers: {
      connected: 5,
      active: 3,
      uploading: 0,
      countries: [
        { code: "ES", count: 2 },
        { code: "FR", count: 1 },
      ],
    },
    downloadKBps: 500,
    uploadKBps: 0,
    path: "direct",
    recoveries: 0,
    viewers: 0,
    hls: { preview: "", full: "", thumbnail: "" },
    engine: { name: "shared-direct", shared: true },
    standbys: [],
  };
}

test("exports the countries of the engine's sending peers with the engine they belong to", async () => {
  const registry = new Registry();
  new ControllerMetrics(registry, () => ({
    streams: [streamOnSharedEngine("s1"), streamOnSharedEngine("s2")],
    paths: [],
  }));
  const scrape = await registry.metrics();
  // Both streams report the engine's countries, so a dashboard counts each engine once.
  for (const id of ["s1", "s2"]) {
    expect(scrape).toContain(`aceswarm_stream_peer_countries{stream="${id}",engine="shared-direct",country="ES"} 2`);
    expect(scrape).toContain(`aceswarm_stream_peer_countries{stream="${id}",engine="shared-direct",country="FR"} 1`);
  }
});

test("exports the age of a stream's last frame while it runs, not once it is stopped", async () => {
  const registry = new Registry();
  const stream: StreamView = {
    id: "s1",
    aceId: "a".repeat(40),
    aceIdKind: "infohash",
    name: "One",
    enabled: true,
    createdAt: "2026-11-06T10:00:00.000Z",
    state: "recovering",
    stateSince: "2026-11-06T10:00:00.000Z",
    message: null,
    lastFrameAt: new Date(Date.now() - 90_000).toISOString(),
    liveEdge: null,
    peers: { connected: null, active: null, uploading: null, countries: [] },
    downloadKBps: null,
    uploadKBps: null,
    path: "direct",
    recoveries: 1,
    viewers: 0,
    hls: { preview: "", full: "", thumbnail: "" },
    engine: null,
    standbys: [],
  };
  let streams = [stream];
  let since = 0;
  new ControllerMetrics(
    registry,
    () => ({ streams, paths: [] }),
    () => [],
    { runningSince: () => since },
  );
  const age = async (): Promise<number | undefined> => {
    const match = /^aceswarm_stream_last_frame_age_seconds\{stream="s1"\} (\S+)$/m.exec(await registry.metrics());
    return match === null ? undefined : Number(match[1]);
  };
  // A stream that recovers has no frame from its new pipeline yet: its age is that of its last video.
  expect(await age()).toBeGreaterThanOrEqual(90);
  expect(await age()).toBeLessThan(100);

  // A disabled stream keeps the time for the UI, but it isn't expected to have video, and it is on no path.
  streams = [{ ...stream, enabled: false, state: "stopped", path: null }];
  expect(await age()).toBeUndefined();
  expect(await registry.metrics()).not.toContain('aceswarm_stream_path{stream="s1"');

  // Enabled again a minute ago: the time since its last frame, from before it was disabled, is no
  // outage. Its age is back with the first video of the new run, and stays when that run recovers.
  since = Date.now() - 60_000;
  streams = [{ ...stream, state: "starting" }];
  expect(await age()).toBeUndefined();
  streams = [{ ...stream, state: "recovering", lastFrameAt: new Date(Date.now() - 30_000).toISOString() }];
  expect(await age()).toBeGreaterThanOrEqual(30);
  expect(await age()).toBeLessThan(40);
});

test("a disabled stream has no up value, so it is neither an outage nor in the availability", async () => {
  const registry = new Registry();
  const stream: StreamView = {
    id: "s1",
    aceId: "a".repeat(40),
    aceIdKind: "infohash",
    name: "One",
    enabled: true,
    createdAt: "2026-11-06T10:00:00.000Z",
    state: "playing",
    stateSince: "2026-11-06T10:00:00.000Z",
    message: null,
    lastFrameAt: null,
    liveEdge: null,
    peers: { connected: null, active: null, uploading: null, countries: [] },
    downloadKBps: null,
    uploadKBps: null,
    path: "direct",
    recoveries: 0,
    viewers: 0,
    hls: { preview: "", full: "", thumbnail: "" },
    engine: null,
    standbys: [],
  };
  let current = stream;
  new ControllerMetrics(registry, () => ({ streams: [current], paths: [] }));
  const up = async (): Promise<string | undefined> =>
    /^aceswarm_stream_up\{stream="s1"\} (\S+)$/m.exec(await registry.metrics())?.[1];

  expect(await up()).toBe("1");
  // Enabled and not playing is an outage: 0.
  current = { ...stream, state: "recovering" };
  expect(await up()).toBe("0");
  // Turned off on purpose: no value, but the stream is still listed, and its state says why.
  current = { ...stream, enabled: false, state: "stopped", path: null };
  expect(await up()).toBeUndefined();
  const scrape = await registry.metrics();
  expect(scrape).toContain('aceswarm_stream_info{stream="s1",name="One"');
  expect(scrape).toContain('aceswarm_stream_state{stream="s1",state="stopped"} 1');
  // Enabled again: it counts as soon as it has a state of its own.
  current = { ...stream, state: "starting" };
  expect(await up()).toBe("0");
  // Enabled but with no run yet (the controller listens while it starts up): an outage, not "disabled".
  current = { ...stream, state: "stopped", path: null };
  expect(await up()).toBe("0");
  // Just disabled, in a snapshot whose state is a moment old: already off.
  current = { ...stream, enabled: false };
  expect(await up()).toBeUndefined();
});

test("exports how long the broadcast is quiet from the stream's quiet time, not from the session's own edge", async () => {
  const registry = new Registry();
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const waiting: StreamView = {
    id: "s1",
    aceId: "a".repeat(40),
    aceIdKind: "infohash",
    name: "One",
    enabled: true,
    createdAt: "2026-11-06T10:00:00.000Z",
    state: "stale-source",
    stateSince: "2026-11-06T10:00:00.000Z",
    message: null,
    lastFrameAt: ago(150_000),
    // A retry opened a session 13 s ago, whose edge was first seen then. The broadcast sent its
    // last new data more than two minutes ago.
    liveEdge: {
      state: "waiting",
      edgeAt: ago(147_000),
      advancedAt: ago(13_000),
      quietSince: ago(127_000),
      behindSeconds: 0,
    },
    peers: { connected: null, active: null, uploading: null, countries: [] },
    downloadKBps: null,
    uploadKBps: null,
    path: "direct",
    recoveries: 3,
    viewers: 0,
    hls: { preview: "", full: "", thumbnail: "" },
    engine: null,
    standbys: [],
  };
  let current = waiting;
  new ControllerMetrics(registry, () => ({ streams: [current], paths: [] }));
  const seconds = async (metric: string): Promise<number | undefined> => {
    const match = new RegExp(String.raw`^${metric}\{stream="s1"\} (\S+)$`, "m").exec(await registry.metrics());
    return match === null ? undefined : Number(match[1]);
  };
  const quiet = async (): Promise<number | undefined> => seconds("aceswarm_stream_source_quiet_seconds");

  // The retry's own edge started over; how long the broadcast is quiet did not.
  expect(await quiet()).toBeGreaterThanOrEqual(127);
  expect(await quiet()).toBeLessThan(137);
  expect(await seconds("aceswarm_stream_live_edge_unchanged_seconds")).toBeGreaterThanOrEqual(13);
  expect(await seconds("aceswarm_stream_live_edge_unchanged_seconds")).toBeLessThan(23);

  // The next retry's session has no live position yet, and still says since when.
  current = {
    ...waiting,
    liveEdge: { state: "waiting", edgeAt: null, advancedAt: null, quietSince: ago(187_000), behindSeconds: null },
  };
  expect(await quiet()).toBeGreaterThanOrEqual(187);
  expect(await seconds("aceswarm_stream_live_edge_unchanged_seconds")).toBeUndefined();

  // While the stream plays, the edge of its live session keeps moving: about 0.
  const live = ago(1000);
  current = {
    ...waiting,
    state: "playing",
    liveEdge: { state: "live", edgeAt: live, advancedAt: live, quietSince: live, behindSeconds: 4 },
  };
  expect(await quiet()).toBeGreaterThanOrEqual(1);
  expect(await quiet()).toBeLessThan(11);
  // The transcoder's clock a little ahead of ours is no negative time.
  const ahead = new Date(Date.now() + 5000).toISOString();
  current = {
    ...current,
    liveEdge: { state: "live", edgeAt: ahead, advancedAt: ahead, quietSince: ahead, behindSeconds: 4 },
  };
  expect(await quiet()).toBe(0);

  // Nothing known: the stream's first session before its first live position, a source without
  // one, and a stream without a session.
  current = {
    ...waiting,
    liveEdge: { state: "none", edgeAt: null, advancedAt: null, quietSince: null, behindSeconds: null },
  };
  expect(await quiet()).toBeUndefined();
  current = { ...waiting, enabled: false, state: "stopped", path: null, liveEdge: null };
  expect(await quiet()).toBeUndefined();
});

test("counts how long engines ran by kind and reason, with every reason there from the start", async () => {
  const registry = new Registry();
  const metrics = new ControllerMetrics(registry, () => ({ streams: [], paths: [] }));

  const before = await registry.metrics();
  // At zero before the first engine goes, so that one shows as an increase.
  for (const series of [
    'aceswarm_engine_lifetime_seconds_count{kind="own",reason="moved"} 0',
    'aceswarm_engine_lifetime_seconds_count{kind="own",reason="restart"} 0',
    'aceswarm_engine_lifetime_seconds_count{kind="own",reason="oom-killed"} 0',
    'aceswarm_engine_lifetime_seconds_count{kind="shared",reason="replaced"} 0',
    'aceswarm_engine_lifetime_seconds_count{kind="shared",reason="exited"} 0',
    'aceswarm_engine_lifetime_seconds_bucket{le="30",kind="own",reason="move-failed"} 0',
  ]) {
    expect(before).toContain(series);
  }
  // Only a stream's own engine restarts in its container.
  expect(before).not.toContain('kind="shared",reason="restart"');
  expect(before.match(/^aceswarm_engine_lifetime_seconds_count/gm)).toHaveLength(15);

  metrics.engineLifetime.observe({ kind: "own", reason: "moved" }, 45);
  metrics.engineLifetime.observe({ kind: "own", reason: "moved" }, 7200);
  metrics.engineLifetime.observe({ kind: "own", reason: "moved" }, 2 * 7 * 86_400);

  const after = await registry.metrics();
  expect(after).toContain('aceswarm_engine_lifetime_seconds_bucket{le="30",kind="own",reason="moved"} 0');
  expect(after).toContain('aceswarm_engine_lifetime_seconds_bucket{le="60",kind="own",reason="moved"} 1');
  expect(after).toContain('aceswarm_engine_lifetime_seconds_bucket{le="21600",kind="own",reason="moved"} 2');
  expect(after).toContain('aceswarm_engine_lifetime_seconds_bucket{le="604800",kind="own",reason="moved"} 2');
  expect(after).toContain('aceswarm_engine_lifetime_seconds_bucket{le="+Inf",kind="own",reason="moved"} 3');
  expect(after).toContain('aceswarm_engine_lifetime_seconds_count{kind="own",reason="moved"} 3');
});
