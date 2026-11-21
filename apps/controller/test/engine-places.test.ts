import type { StreamView } from "@aceswarm/shared/api-types";
import { expect, test } from "vitest";
import { EnginePlaces, LEFT_HOLD_MS, PLACE_HOLD_MS, type KeptEngine } from "../src/engine-places.ts";

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

/** An engine of a stream. */
const own = (engine: string): { engine: string; sharedPath: null } => ({ engine, sharedPath: null });
/** The direct path's shared engine. */
const SHARED = { engine: "shared-direct-1", sharedPath: "direct" };

function placesWith(kept: KeptEngine[] = []): { places: EnginePlaces; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  const places = new EnginePlaces(
    () => kept,
    () => clock.now,
  );
  return { places, clock };
}

test("an engine is the one its stream plays from, a standby, a kept one or a path's shared one", () => {
  const { places } = placesWith([{ engine: "e3", path: "wg:b" }]);
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
  expect(places.resolve(engines, streams)).toEqual([
    { role: "playing", path: "direct" },
    { role: "standby", path: "wg:a" },
    { role: "kept", path: "wg:b" },
    { role: "shared", path: "direct" },
  ]);
});

test("a failover swaps the roles of two engines, and each keeps its path", () => {
  const { places } = placesWith();
  const before = stream("s1", {
    engine: { name: "e1", shared: false },
    standbys: [{ path: "wg:a", state: "hot", engine: { name: "e2", shared: false }, reason: null }],
  });
  const engines = [own("e1"), own("e2")];
  expect(places.resolve(engines, [before]).map((place) => place.role)).toEqual(["playing", "standby"]);

  const after = stream("s1", {
    path: "wg:a",
    engine: { name: "e2", shared: false },
    standbys: [{ path: "direct", state: "starting", engine: { name: "e1", shared: false }, reason: null }],
  });
  expect(places.resolve(engines, [after])).toEqual([
    { role: "standby", path: "direct" },
    { role: "playing", path: "wg:a" },
  ]);
});

test("an engine in no list keeps the place it had for a while, then counts as a leftover", () => {
  const { places, clock } = placesWith();
  const playing = stream("s1", {
    engine: { name: "e1", shared: false },
    standbys: [{ path: "wg:a", state: "hot", engine: { name: "e2", shared: false }, reason: null }],
  });
  const engines = [own("e1"), own("e2")];
  places.resolve(engines, [playing]);

  // While a failover hands over, the standby it took is in no list.
  const handingOver = stream("s1", { engine: { name: "e1", shared: false } });
  clock.now += 30_000;
  expect(places.resolve(engines, [handingOver])[1]).toEqual({ role: "standby", path: "wg:a" });
  clock.now += PLACE_HOLD_MS - 30_000;
  expect(places.resolve(engines, [handingOver])[1]).toEqual({ role: "standby", path: "wg:a" });
  clock.now += 1;
  expect(places.resolve(engines, [handingOver])[1]).toEqual({ role: "other", path: "" });

  // It has a place again as soon as it is in a list.
  expect(places.resolve(engines, [playing])[1]).toEqual({ role: "standby", path: "wg:a" });
});

test("a new engine is starting until it has a place, and a leftover once that takes too long", () => {
  const { places, clock } = placesWith();
  const starting = stream("s1", { state: "starting", engine: null });
  expect(places.resolve([own("e1")], [starting])).toEqual([{ role: "starting", path: "" }]);
  clock.now += PLACE_HOLD_MS;
  expect(places.resolve([own("e1")], [starting])).toEqual([{ role: "starting", path: "" }]);
  clock.now += 1;
  expect(places.resolve([own("e1")], [starting])).toEqual([{ role: "other", path: "" }]);

  const playing = stream("s1", { engine: { name: "e1", shared: false } });
  expect(places.resolve([own("e1")], [playing])).toEqual([{ role: "playing", path: "direct" }]);
});

test("an engine that is gone is forgotten: a new one with its name starts over", () => {
  const { places, clock } = placesWith();
  const playing = stream("s1", { engine: { name: "e1", shared: false } });
  const stopped = stream("s1", { state: "stopped", path: null, engine: null });
  places.resolve([own("e1")], [playing]);
  // The stream was disabled and its engine removed; enabled again, its first engine has the same name.
  places.resolve([], [stopped]);
  clock.now += 1000;
  expect(places.resolve([own("e1")], [stopped])).toEqual([{ role: "starting", path: "" }]);
});

test("a shared engine is its path's from its first moment, whatever the streams are doing", () => {
  const { places, clock } = placesWith();
  // Still starting, so no stream names it yet: its container says which path it is of.
  expect(places.resolve([SHARED], [])).toEqual([{ role: "shared", path: "direct" }]);
  // And for longer than an engine of a stream keeps its place.
  clock.now += PLACE_HOLD_MS + 1;
  expect(places.resolve([SHARED], [])).toEqual([{ role: "shared", path: "direct" }]);
});

test("the engine a stream plays from wins over a standby or a kept engine of the same name", () => {
  const { places } = placesWith([{ engine: "e1", path: "wg:b" }]);
  const both = stream("s1", {
    path: "wg:a",
    engine: { name: "e1", shared: false },
    standbys: [{ path: "wg:a", state: "hot", engine: { name: "e1", shared: false }, reason: null }],
  });
  expect(places.resolve([own("e1")], [both])).toEqual([{ role: "playing", path: "wg:a" }]);
});

test("a stream without a path has an engine without one", () => {
  const { places } = placesWith();
  const noPath = stream("s1", { path: null, engine: { name: "e1", shared: false } });
  expect(places.resolve([own("e1")], [noPath])).toEqual([{ role: "playing", path: "" }]);
});

test("says what an engine that is about to go was for: its place at the last look, while that is recent", () => {
  const { places, clock } = placesWith();
  const engines = [own("e1"), own("e2"), own("e3")];
  const playing = stream("s1", {
    engine: { name: "e1", shared: false },
    standbys: [{ path: "wg:a", state: "hot", engine: { name: "e2", shared: false }, reason: null }],
  });
  // Never looked at: nothing is known of it.
  expect(places.placeOf("e1")).toBeUndefined();

  places.resolve(engines, [playing]);
  expect(places.placeOf("e1")).toEqual({ role: "playing", path: "direct" });
  expect(places.placeOf("e2")).toEqual({ role: "standby", path: "wg:a" });
  // An engine that never had a place is one that starts.
  expect(places.placeOf("e3")).toEqual({ role: "starting", path: "" });

  // The stream moved to e3: the engine it left is still the one that played on the direct path.
  clock.now += 15_000;
  places.resolve(engines, [stream("s1", { path: "wg:b", engine: { name: "e3", shared: false } })]);
  expect(places.placeOf("e1")).toEqual({ role: "playing", path: "direct" });
  expect(places.placeOf("e3")).toEqual({ role: "playing", path: "wg:b" });

  // Left behind for longer than a handover takes, it is nobody's.
  clock.now += PLACE_HOLD_MS + 1;
  expect(places.placeOf("e1")).toEqual({ role: "other", path: "" });

  // Gone from the containers there are, it is forgotten after a short while.
  const moved = [stream("s1", { path: "wg:b", engine: { name: "e3", shared: false } })];
  places.resolve([own("e3")], moved);
  expect(places.placeOf("e1")).toEqual({ role: "other", path: "" });
  clock.now += LEFT_HOLD_MS + 1;
  expect(places.placeOf("e1")).toBeUndefined();
  places.resolve([own("e3")], moved);
  expect(places.placeOf("e1")).toBeUndefined();
});

test("still says what an engine was for when it has just left the containers there are", () => {
  const { places, clock } = placesWith();
  const playing = stream("s1", { engine: { name: "e1", shared: false } });
  places.resolve([own("e1")], [playing]);

  // It is stopping or restarting: out of a sample or two before its exit shows.
  clock.now += 15_000;
  places.resolve([], [playing]);
  clock.now += 15_000;
  places.resolve([], [playing]);
  expect(places.placeOf("e1")).toEqual({ role: "playing", path: "direct" });
  clock.now += LEFT_HOLD_MS - 15_000;
  expect(places.placeOf("e1")).toEqual({ role: "playing", path: "direct" });
  clock.now += 1;
  expect(places.placeOf("e1")).toBeUndefined();
});

test("a new engine with the name of one that just left is not taken for it", () => {
  const { places, clock } = placesWith();
  const playing = stream("s1", { engine: { name: "e1", shared: false } });
  const starting = stream("s1", { state: "starting", engine: null });
  places.resolve([own("e1")], [playing]);
  places.resolve([], [starting]);
  expect(places.placeOf("e1")).toEqual({ role: "playing", path: "direct" });

  // The stream was disabled and enabled again: its new engine has the old one's name.
  clock.now += 5000;
  expect(places.resolve([own("e1")], [starting])).toEqual([{ role: "starting", path: "" }]);
  expect(places.placeOf("e1")).toEqual({ role: "starting", path: "" });
  // And when that one leaves too, it is the one remembered.
  clock.now += 5000;
  places.resolve([], [starting]);
  expect(places.placeOf("e1")).toEqual({ role: "starting", path: "" });
});
