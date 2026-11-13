import type { PipelineStatus } from "@aceswarm/shared/api-types";
import { describe, expect, it } from "vitest";
import { duration, evaluateHealth, type HealthInputs } from "../src/health.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");

function pipeline(overrides: Partial<PipelineStatus> = {}): PipelineStatus {
  return {
    id: "abc123",
    state: "running",
    source: "http://engine/ace/r/x",
    startedAt: new Date(NOW - 60_000).toISOString(),
    lastFrameAt: null,
    frames: 0,
    fps: null,
    videoCodec: null,
    mode: "copy",
    exitCode: null,
    error: null,
    pendingSource: null,
    liveEdge: null,
    ...overrides,
  };
}

function inputs(overrides: Partial<HealthInputs>): HealthInputs {
  return {
    now: NOW,
    attemptStartedAt: NOW - 10_000,
    pipeline: undefined,
    engineStatus: undefined,
    stallAfterMs: 20_000,
    startupGraceMs: 60_000,
    ...overrides,
  };
}

const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe("evaluateHealth", () => {
  it("is playing while frames are recent", () => {
    const recent = pipeline({ lastFrameAt: ago(5000) });
    expect(evaluateHealth(inputs({ pipeline: recent }))).toMatchObject({
      state: "playing",
      healthy: true,
    });
  });

  it("is stalled when frames stop", () => {
    const old = pipeline({ lastFrameAt: ago(45_000) });
    expect(evaluateHealth(inputs({ pipeline: old }))).toEqual({
      state: "stalled",
      healthy: false,
      reason: "no new video for 45s",
    });
  });

  it("reports a pipeline that exited", () => {
    const health = evaluateHealth(inputs({ pipeline: pipeline({ state: "exited", error: "input timed out" }) }));
    expect(health).toEqual({ state: "stalled", healthy: false, reason: "pipeline exited: input timed out" });
  });

  it("distinguishes buffering from starting during the grace period", () => {
    expect(evaluateHealth(inputs({ engineStatus: "prebuf" })).state).toBe("buffering");
    expect(evaluateHealth(inputs({ engineStatus: "dl" })).state).toBe("starting");
  });

  it("gives up after the startup grace period", () => {
    expect(evaluateHealth(inputs({ attemptStartedAt: NOW - 90_000 }))).toEqual({
      state: "stalled",
      healthy: false,
      reason: "no video after 90s",
    });
  });
});

function stale(advancedAt: number, behindSeconds = 0): PipelineStatus["liveEdge"] {
  return {
    state: "stale",
    edgeAt: new Date(advancedAt).toISOString(),
    advancedAt: new Date(advancedAt).toISOString(),
    behindSeconds,
  };
}

describe("a source whose live edge stopped", () => {
  it("is a stale source, before any other reading of the pipeline", () => {
    const stopped = pipeline({ state: "exited", error: "stopped reading", liveEdge: stale(NOW - 2_242_000) });
    expect(evaluateHealth(inputs({ pipeline: stopped }))).toEqual({
      state: "stale-source",
      healthy: false,
      reason: "no new data from the broadcast for 37m",
    });
  });

  it("says when the engine serves the broadcast far behind its live edge", () => {
    const late = pipeline({ liveEdge: stale(NOW - 1000, 75) });
    expect(evaluateHealth(inputs({ pipeline: late })).reason).toBe("the engine serves the broadcast 75s late");
  });

  it("waits for video while a new source's live edge has not moved yet", () => {
    const waiting = pipeline({ liveEdge: { state: "waiting", edgeAt: null, advancedAt: null, behindSeconds: null } });
    expect(evaluateHealth(inputs({ pipeline: waiting })).state).toBe("starting");
  });
});

describe("duration", () => {
  it("is in seconds up to two minutes, then minutes, then hours", () => {
    expect([59_000, 119_400, 120_000, 7_199_000, 7_260_000].map((ms) => duration(ms))).toEqual([
      "59s",
      "119s",
      "2m",
      "119m",
      "2h 1m",
    ]);
  });
});
