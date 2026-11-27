import { Registry } from "@prometheus-io/client";
import type { StandbySource } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { expect, test } from "vitest";
import type { AcestreamClient } from "../src/acestream.ts";
import type { NetgwClient, TranscoderClient } from "../src/clients.ts";
import type { EngineHandle, EngineManager, OnEngineAddress } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import { DEFAULT_STANDBY_SETTINGS, StreamStandbys, type StandbyContext, type StandbySettings } from "../src/standby.ts";

/**
 * A stream's standbys over fakes: engines that start at once, and a transcoder whose readers get
 * data from every standby session. `check` runs one check and lets its background work finish.
 */
function standbysOf(settings: Partial<StandbySettings>) {
  const clock = { now: 1000 };
  const removed: string[] = [];
  let created = 0;
  const engines = {
    create: async (streamId: string, generation: number, onAddress?: OnEngineAddress) => {
      created += 1;
      const ip = `172.31.250.${String(10 + generation)}`;
      const name = `aceswarm-engine-${streamId}-${String(generation)}`;
      const handle: EngineHandle = {
        containerId: `c${String(generation)}`,
        name,
        streamId,
        generation,
        ip,
        baseUrl: `http://${ip}:6878`,
        sharedPath: null,
      };
      await onAddress?.(handle);
      return handle;
    },
    remove: (handle: Pick<EngineHandle, "containerId">) => {
      removed.push(handle.containerId);
      return Promise.resolve();
    },
    ownName: (streamId: string, generation: number) => `aceswarm-engine-${streamId}-${String(generation)}`,
  } as unknown as EngineManager;
  const transcoder = {
    setStandbys: (_id: string, sources: StandbySource[]) =>
      Promise.resolve(
        sources.map(({ source }) => ({
          source,
          state: "receiving",
          bytes: 0,
          lastDataAt: new Date(clock.now).toISOString(),
          error: null,
          liveEdge: null,
        })),
      ),
  } as unknown as TranscoderClient;
  let generation = 1;
  const standbys = new StreamStandbys({
    streamId: "s1",
    engines,
    ace: { stopSession: () => Promise.resolve() } as unknown as AcestreamClient,
    transcoder,
    netgw: { assign: () => Promise.resolve(), unassign: () => Promise.resolve() } as unknown as NetgwClient,
    metrics: new ControllerMetrics(new Registry(), () => ({ streams: [], paths: [] })),
    logger: createLogger("test", "silent"),
    settings: { ...DEFAULT_STANDBY_SETTINGS, ...settings },
    nextGeneration: () => (generation += 1),
    now: () => clock.now,
  });
  /** What a stream that plays on the direct path knows, with every path up unless `down` names it. */
  const context = (candidates: string[], more: Partial<StandbyContext> & { down?: string[] } = {}): StandbyContext => ({
    enabled: true,
    sharing: false,
    known: true,
    current: "direct",
    candidates: candidates.filter((path) => more.down?.includes(path) !== true),
    usable: () => true,
    up: (path) => more.down?.includes(path) !== true,
    active: true,
    sparePath: undefined,
    transcoderSources: [],
    openSession: (baseUrl) =>
      Promise.resolve({ playbackUrl: `${baseUrl}/play`, statUrl: `${baseUrl}/stat`, commandUrl: `${baseUrl}/cmd` }),
    ...more,
  });
  const check = async (with_: StandbyContext, times = 1): Promise<void> => {
    for (let time = 0; time < times; time += 1) {
      clock.now += 2000;
      await standbys.maintain(with_);
      await standbys.settle();
    }
  };
  const paths = (): string[] => standbys.view().map(({ path }) => path);
  return { standbys, context, check, paths, removed, created: () => created };
}

test("a kept engine on the favourite path leaves the other path its only standby", async () => {
  const { context, check, paths, removed, created } = standbysOf({ maxPaths: 1 });
  // The stream kept the engine of a failed move to the favourite path: that path gets no standby.
  const kept = context(["wg:fav", "wg:other"], { favourite: "wg:fav", sparePath: "wg:fav" });
  await check(kept, 5);
  expect(paths()).toEqual(["wg:other"]);
  expect(removed).toEqual([]);
  expect(created()).toBe(1);

  // Once the kept engine is gone, the favourite path gets the standby, and the other one goes for it.
  await check(context(["wg:fav", "wg:other"], { favourite: "wg:fav" }), 2);
  expect(paths()).toEqual(["wg:fav"]);
  expect(removed).toEqual(["c2"]);
  expect(created()).toBe(2);
});

test("a standby whose path is down goes first for the favourite path's", async () => {
  const { context, check, paths, removed } = standbysOf({ maxPaths: 2 });
  await check(context(["wg:a", "wg:b"]), 2);
  expect(paths()).toEqual(["wg:a", "wg:b"]);

  // The better path of the two goes down: its standby stays a while, in case the path comes back.
  await check(context(["wg:a", "wg:b"], { down: ["wg:a"] }));
  expect(paths()).toEqual(["wg:a", "wg:b"]);
  expect(removed).toEqual([]);

  // A favourite path that is new to the stream gets its standby in that one's place.
  await check(context(["wg:fav", "wg:a", "wg:b"], { down: ["wg:a"], favourite: "wg:fav" }));
  expect(paths()).toEqual(["wg:b", "wg:fav"]);
  expect(removed).toEqual(["c2"]);
});

test("the standby on the worst path goes for the favourite path's when every path is up", async () => {
  const { context, check, paths, removed } = standbysOf({ maxPaths: 2 });
  await check(context(["wg:a", "wg:b"]), 2);
  await check(context(["wg:fav", "wg:a", "wg:b"], { favourite: "wg:fav" }));
  expect(paths()).toEqual(["wg:a", "wg:fav"]);
  expect(removed).toEqual(["c3"]);
});
