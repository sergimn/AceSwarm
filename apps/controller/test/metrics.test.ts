import { Registry } from "@prometheus-io/client";
import type { ViewerView } from "@aceswarm/shared/api-types";
import { expect, test } from "vitest";
import { ControllerMetrics } from "../src/metrics.ts";
import type { SharedEngineView } from "../src/shared-engines.ts";

test("every scrape shows the current values, not the previous scrape's", async () => {
  const registry = new Registry();
  let viewers: ViewerView[] = [];
  let shared: SharedEngineView[] = [];
  new ControllerMetrics(
    registry,
    () => ({ streams: [], paths: [] }),
    () => [],
    { viewers: () => viewers, sharedEngines: () => shared },
  );
  expect(await registry.metrics()).not.toContain("aceswarm_viewer_watching{");

  viewers = [{ viewer: "0123456789abcdef", stream: "s1", device: "Chrome on TV", since: "2026-11-05T19:00:00.000Z" }];
  shared = [{ path: "direct", engine: "aceswarm-engine-shared-direct-1", streams: 2, retiring: false }];
  const scrape = await registry.metrics();
  expect(scrape).toContain('aceswarm_viewer_watching{viewer="0123456789abcdef",device="Chrome on TV",stream="s1"} 1');
  expect(scrape).toContain(
    'aceswarm_shared_engine_streams{path="direct",engine="aceswarm-engine-shared-direct-1",retiring="false"} 2',
  );

  viewers = [];
  expect(await registry.metrics()).not.toContain("aceswarm_viewer_watching{");
});
