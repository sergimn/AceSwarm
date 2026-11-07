import { Registry } from "@prometheus-io/client";
import { createLogger } from "@aceswarm/shared/logger";
import { expect, test } from "vitest";
import type { AcestreamClient } from "../src/acestream.ts";
import type { NetgwClient } from "../src/clients.ts";
import { EnginePaths } from "../src/engine-paths.ts";
import type { EngineHandle, EngineManager } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import { StandbyEngine } from "../src/standby-engine.ts";

const engine: EngineHandle = {
  containerId: "c2",
  name: "aceswarm-engine-s1-2",
  streamId: "s1",
  generation: 2,
  ip: "172.31.250.12",
  baseUrl: "http://172.31.250.12:6878",
  sharedPath: null,
};

test("a standby being removed still owns its engine until the container is gone", async () => {
  const removal = Promise.withResolvers<undefined>();
  const removed: string[] = [];
  const engines = {
    remove: async (handle: Pick<EngineHandle, "containerId">) => {
      await removal.promise;
      removed.push(handle.containerId);
    },
  } as unknown as EngineManager;
  const netgw = { assign: () => Promise.resolve(), unassign: () => Promise.resolve() } as unknown as NetgwClient;
  const standby = StandbyEngine.adopted("wg:a", engine, {
    streamId: "s1",
    engines,
    ace: { stopSession: () => Promise.resolve() } as unknown as AcestreamClient,
    metrics: new ControllerMetrics(new Registry(), () => ({ streams: [], paths: [] })),
    logger: createLogger("test", "silent"),
    gateway: new EnginePaths(netgw),
    nextGeneration: () => 3,
    now: () => 1000,
  });
  expect(standby.owns(engine)).toBe(true);

  const disposed = standby.dispose("hot standby is off");
  await new Promise((resolve) => setImmediate(resolve));
  // A start of the stream's own engine meanwhile must not remove the container a second time.
  expect(standby.owns(engine)).toBe(true);
  expect(standby.engine).toBeUndefined();

  removal.resolve(undefined);
  await disposed;
  expect(removed).toEqual([engine.containerId]);
  expect(standby.owns(engine)).toBe(false);
});
