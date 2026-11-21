import type { StreamView } from "@aceswarm/shared/api-types";
import { expect, test } from "vitest";
import { EngineSlots, SLOT_HOLD_MS, type EnginePath } from "../src/engine-slots.ts";

function stream(id: string, over: Partial<StreamView> = {}): StreamView {
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
    peers: { connected: null, active: null, uploading: null, countries: [] },
    downloadKBps: null,
    uploadKBps: null,
    path: "direct",
    recoveries: 0,
    viewers: 0,
    hls: { preview: "", full: "", thumbnail: "" },
    engine: null,
    standbys: [],
    ...over,
  };
}

const own = (engine: string): { engine: string; stream: string } => ({ engine, stream: "s1" });
/** A shared engine: it has no stream. */
const SHARED = { engine: "shared-direct-1", stream: "" };

function slotsWith(sources: { kept?: EnginePath[]; shared?: EnginePath[] } = {}): {
  slots: EngineSlots;
  clock: { now: number };
} {
  const clock = { now: 1_000_000 };
  const slots = new EngineSlots({
    kept: () => sources.kept ?? [],
    shared: () => sources.shared ?? [],
    now: () => clock.now,
  });
  return { slots, clock };
}

test("an engine is the one its stream plays from, a standby, a kept one or a path's shared one", () => {
  const { slots } = slotsWith({
    kept: [{ engine: "e3", path: "wg:b" }],
    shared: [{ engine: "shared-direct-1", path: "direct" }],
  });
  const streams = [
    stream("s1", {
      engine: { name: "e1", shared: false },
      standbys: [
        { path: "wg:a", state: "hot", engine: { name: "e2", shared: false }, reason: null },
        // Still starting: its engine has no name yet.
        { path: "wg:c", state: "starting", engine: null, reason: null },
      ],
    }),
    // Plays from the shared engine, with a standby session on another: neither is an engine of its own.
    stream("s2", {
      engine: { name: "shared-direct-1", shared: true },
      standbys: [{ path: "wg:a", state: "hot", engine: { name: "shared-wg-a-1", shared: true }, reason: null }],
    }),
  ];
  const engines = [own("e1"), own("e2"), own("e3"), SHARED];
  expect(slots.resolve(engines, streams)).toEqual([
    { role: "playing", path: "direct" },
    { role: "standby", path: "wg:a" },
    { role: "kept", path: "wg:b" },
    { role: "shared", path: "direct" },
  ]);
});

test("a failover swaps the roles of two engines, and each keeps its path", () => {
  const { slots } = slotsWith();
  const before = stream("s1", {
    engine: { name: "e1", shared: false },
    standbys: [{ path: "wg:a", state: "hot", engine: { name: "e2", shared: false }, reason: null }],
  });
  const engines = [own("e1"), own("e2")];
  expect(slots.resolve(engines, [before]).map((slot) => slot.role)).toEqual(["playing", "standby"]);

  const after = stream("s1", {
    path: "wg:a",
    engine: { name: "e2", shared: false },
    standbys: [{ path: "direct", state: "starting", engine: { name: "e1", shared: false }, reason: null }],
  });
  expect(slots.resolve(engines, [after])).toEqual([
    { role: "standby", path: "direct" },
    { role: "playing", path: "wg:a" },
  ]);
});

test("an engine in no list keeps the place it had for a while, then counts as a leftover", () => {
  const { slots, clock } = slotsWith();
  const playing = stream("s1", {
    engine: { name: "e1", shared: false },
    standbys: [{ path: "wg:a", state: "hot", engine: { name: "e2", shared: false }, reason: null }],
  });
  const engines = [own("e1"), own("e2")];
  slots.resolve(engines, [playing]);

  // While a failover hands over, the standby it took is in no list.
  const handingOver = stream("s1", { engine: { name: "e1", shared: false } });
  clock.now += 30_000;
  expect(slots.resolve(engines, [handingOver])[1]).toEqual({ role: "standby", path: "wg:a" });
  clock.now += SLOT_HOLD_MS - 30_000;
  expect(slots.resolve(engines, [handingOver])[1]).toEqual({ role: "standby", path: "wg:a" });
  clock.now += 1;
  expect(slots.resolve(engines, [handingOver])[1]).toEqual({ role: "other", path: "" });

  // It has a place again as soon as it is in a list.
  expect(slots.resolve(engines, [playing])[1]).toEqual({ role: "standby", path: "wg:a" });
});

test("a new engine is starting until it has a place, and a leftover once that takes too long", () => {
  const { slots, clock } = slotsWith();
  const starting = stream("s1", { state: "starting", engine: null });
  expect(slots.resolve([own("e1")], [starting])).toEqual([{ role: "starting", path: "" }]);
  clock.now += SLOT_HOLD_MS;
  expect(slots.resolve([own("e1")], [starting])).toEqual([{ role: "starting", path: "" }]);
  clock.now += 1;
  expect(slots.resolve([own("e1")], [starting])).toEqual([{ role: "other", path: "" }]);

  const playing = stream("s1", { engine: { name: "e1", shared: false } });
  expect(slots.resolve([own("e1")], [playing])).toEqual([{ role: "playing", path: "direct" }]);
});

test("an engine that is gone is forgotten: a new one with its name starts over", () => {
  const { slots, clock } = slotsWith();
  const playing = stream("s1", { engine: { name: "e1", shared: false } });
  const stopped = stream("s1", { state: "stopped", path: null, engine: null });
  slots.resolve([own("e1")], [playing]);
  // The stream was disabled and its engine removed; enabled again, its first engine has the same name.
  slots.resolve([], [stopped]);
  clock.now += 1000;
  expect(slots.resolve([own("e1")], [stopped])).toEqual([{ role: "starting", path: "" }]);
});

test("a shared engine is its path's from the start, and stays so while its path is not known", () => {
  const sources = { shared: [] as EnginePath[] };
  const { slots, clock } = slotsWith(sources);
  // Not listed until its API answers.
  expect(slots.resolve([SHARED], [])).toEqual([{ role: "shared", path: "" }]);
  sources.shared = [{ engine: "shared-direct-1", path: "direct" }];
  expect(slots.resolve([SHARED], [])).toEqual([{ role: "shared", path: "direct" }]);
  // No longer listed, and for longer than an engine of a stream keeps its place: still shared, on its path.
  sources.shared = [];
  clock.now += SLOT_HOLD_MS + 1;
  expect(slots.resolve([SHARED], [])).toEqual([{ role: "shared", path: "direct" }]);
});

test("the engine a stream plays from wins over a standby or a kept engine of the same name", () => {
  const { slots } = slotsWith({ kept: [{ engine: "e1", path: "wg:b" }] });
  const both = stream("s1", {
    path: "wg:a",
    engine: { name: "e1", shared: false },
    standbys: [{ path: "wg:a", state: "hot", engine: { name: "e1", shared: false }, reason: null }],
  });
  expect(slots.resolve([own("e1")], [both])).toEqual([{ role: "playing", path: "wg:a" }]);
});

test("a stream without a path has an engine without one", () => {
  const { slots } = slotsWith();
  const noPath = stream("s1", { path: null, engine: { name: "e1", shared: false } });
  expect(slots.resolve([own("e1")], [noPath])).toEqual([{ role: "playing", path: "" }]);
});
