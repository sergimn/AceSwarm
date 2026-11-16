import { describe, expect, test } from "vitest";
import type { StandbyReaderStatus } from "@aceswarm/shared/api-types";
import type { EngineSession } from "../src/acestream.ts";
import { StandbyEngine, type StandbyEngineDeps } from "../src/standby-engine.ts";
import { readerNote, standbyView, waitingViews } from "../src/standby-view.ts";

const NOW = 100_000;
const never = (): boolean => false;
const HOT_WITHIN = 10_000;

/** A standby on `wg:a`; only its clock matters here. */
function standby(): StandbyEngine {
  const deps = { now: () => NOW } as unknown as StandbyEngineDeps;
  return new StandbyEngine("wg:a", false, deps);
}

/** One with its session open. */
function opened(): StandbyEngine {
  const open = standby();
  open.session = { playbackUrl: "http://engine/play" } as EngineSession;
  return open;
}

function reader(over: Partial<StandbyReaderStatus> = {}): StandbyReaderStatus {
  return {
    source: "http://engine/play",
    state: "receiving",
    bytes: 0,
    lastDataAt: null,
    error: null,
    liveEdge: null,
    ...over,
  };
}

describe("a standby's reason", () => {
  test("is what its reader says while it warms up, and nothing once it is hot", () => {
    const warming = opened();
    warming.readerNote = "ffmpeg decoded no video from it";
    expect(standbyView(warming, HOT_WITHIN)).toMatchObject({
      state: "warming",
      reason: "ffmpeg decoded no video from it",
    });
    warming.readerNote = undefined;
    expect(standbyView(warming, HOT_WITHIN).reason).toBeNull();

    warming.readerNote = "the reader's note from before";
    warming.lastDataAt = NOW - 1000;
    expect(standbyView(warming, HOT_WITHIN)).toMatchObject({ state: "hot", reason: null });
  });

  test("is why its last try failed while it waits for the next, and not the reader's note", () => {
    const failed = opened();
    failed.readerNote = "ffmpeg decoded no video from it";
    failed.failures = 1;
    failed.retryAt = NOW + 5000;
    failed.failure = "could not start again";
    expect(standbyView(failed, HOT_WITHIN)).toMatchObject({ state: "failed", reason: "could not start again" });
  });

  test("is nothing while it starts, whatever its last failure was", () => {
    const starting = standby();
    starting.failure = "could not start again";
    starting.readerNote = "from an earlier session";
    expect(standbyView(starting, HOT_WITHIN)).toMatchObject({ state: "starting", reason: null });
  });

  test("is cut to 60 characters, so that the stream's tile stays readable", () => {
    const failed = opened();
    failed.failures = 1;
    failed.retryAt = NOW + 5000;
    failed.failure = "x".repeat(61);
    expect(standbyView(failed, HOT_WITHIN).reason).toBe(`${"x".repeat(59)}…`);
    failed.failure = "x".repeat(60);
    expect(standbyView(failed, HOT_WITHIN).reason).toBe("x".repeat(60));
  });
});

describe("a path without a standby", () => {
  test("is a failed one without an engine, with why the last standby failed", () => {
    const retries = new Map([["wg:a", { retryAt: NOW + 5000, reason: "no data for 90s" }]]);
    expect(waitingViews(retries, ["wg:a"], never, Infinity)).toEqual([
      { path: "wg:a", state: "failed", engine: null, reason: "no data for 90s" },
    ]);
  });

  test("says it gave up once it gets no more, in the ranking's order", () => {
    const retries = new Map([
      ["wg:b", { retryAt: Infinity, reason: "no data for 90s" }],
      ["wg:a", { retryAt: Infinity, reason: "y".repeat(80) }],
    ]);
    const views = waitingViews(retries, ["wg:a", "wg:b"], never, Infinity);
    expect(views.map(({ path }) => path)).toEqual(["wg:a", "wg:b"]);
    expect(views[0]?.reason).toHaveLength(60);
    expect(views[1]?.reason).toBe("gave up, no data for 90s");
  });

  test("is left out when it has a standby, is not a candidate or there is no room", () => {
    const retries = new Map([
      ["wg:a", { retryAt: Infinity, reason: "x" }],
      ["wg:b", { retryAt: Infinity, reason: "x" }],
      ["wg:c", { retryAt: Infinity, reason: "x" }],
    ]);
    expect(
      waitingViews(retries, ["wg:a", "wg:b"], (path) => path === "wg:a", Infinity).map(({ path }) => path),
    ).toEqual(["wg:b"]);
    expect(waitingViews(retries, ["wg:a", "wg:b", "wg:c"], never, 2).map(({ path }) => path)).toEqual(["wg:a", "wg:b"]);
    expect(waitingViews(retries, ["wg:a"], never, 0)).toEqual([]);
    expect(waitingViews(retries, ["wg:a"], never, -1)).toEqual([]);
  });
});

describe("what a reader says is wrong", () => {
  test("is its error, or that the live edge of the broadcast is stale", () => {
    expect(readerNote(reader())).toBeUndefined();
    expect(readerNote(reader({ error: "the engine answered 500" }))).toBe("the engine answered 500");
    const stale = { state: "stale", edgeAt: null, advancedAt: null, behindSeconds: null } as const;
    expect(readerNote(reader({ liveEdge: stale }))).toBe("its broadcast sends no new data");
    expect(readerNote(reader({ error: "the engine answered 500", liveEdge: stale }))).toBe("the engine answered 500");
    expect(readerNote(reader({ liveEdge: { ...stale, state: "live" } }))).toBeUndefined();
  });

  test("leaves out the address of the engine that its error names", () => {
    expect(readerNote(reader({ error: "fetch failed (connect ECONNREFUSED 172.17.0.5:6878)" }))).toBe("fetch failed");
    expect(readerNote(reader({ error: "connect ETIMEDOUT 172.17.0.5:6878" }))).toBe("connect ETIMEDOUT the engine");
    expect(readerNote(reader({ error: "bad redirect to http://172.17.0.5:6878/ace/r/abc/def" }))).toBe(
      "bad redirect to the engine",
    );
    expect(readerNote(reader({ error: "(connect ECONNREFUSED 172.17.0.5:6878)" }))).toBe("its reader failed");
  });
});
