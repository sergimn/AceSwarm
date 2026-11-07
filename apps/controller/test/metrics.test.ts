import { Registry } from "@prometheus-io/client";
import type { ViewerView } from "@aceswarm/shared/api-types";
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
