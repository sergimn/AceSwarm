import { Registry } from "@prometheus-io/client";
import type { StreamView, ViewerView } from "@aceswarm/shared/api-types";
import { expect, test } from "vitest";
import type { EngineCount } from "../src/engine-resources.ts";
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
    engine: null,
    standbys: [],
  };
  new ControllerMetrics(
    registry,
    () => ({ streams: [stream], paths: [] }),
    () => [
      { stream: "s1", engine: "e1", usedBytes: 300, limitBytes: 512, cacheLimitBytes: 128, cacheBytes: 128 },
      { stream: "", engine: "e2", usedBytes: 900, limitBytes: 0, cacheLimitBytes: null, cacheBytes: 700 },
    ],
  );
  const scrape = await registry.metrics();
  expect(scrape).toContain('aceswarm_stream_peers{stream="s1",kind="uploading"} 1');
  expect(scrape).toContain('aceswarm_engine_memory_cache_bytes{stream="s1",engine="e1"} 128');
  expect(scrape).toContain('aceswarm_engine_memory_cache_limit_bytes{stream="s1",engine="e1"} 128');
  expect(scrape).toContain('aceswarm_engine_memory_cache_bytes{stream="",engine="e2"} 700');
  expect(scrape).not.toContain('aceswarm_engine_memory_cache_limit_bytes{stream="",engine="e2"}');
});
