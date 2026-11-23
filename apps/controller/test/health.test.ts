import type { LiveEdgeView, PipelineStatus } from "@aceswarm/shared/api-types";
import { describe, expect, it } from "vitest";
import { duration, evaluateHealth, lastSignOfVideo, type HealthInputs } from "../src/health.ts";

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
    layout: null,
    layoutChangedAt: null,
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

const STARTING = {
  state: "starting",
  healthy: false,
  reason: "the transcoder started ffmpeg again; waiting for video",
};
/** The stream played for an hour; its run was found stuck `ms` ago, right at its last frame. */
const restarted = (ms: number, overrides: Partial<PipelineStatus> = {}): HealthInputs =>
  inputs({
    attemptStartedAt: NOW - 3_600_000,
    pipeline: pipeline({ state: "starting", lastFrameAt: ago(ms + 500), restartedAt: ago(ms), ...overrides }),
  });

describe("evaluateHealth after the transcoder started ffmpeg again by itself", () => {
  it("waits for the new run for the startup grace, though the last frame is older than the stall time", () => {
    // Not even a standby takes over early: the stream counts as starting, not as playing.
    expect(evaluateHealth(restarted(1000))).toEqual(STARTING);
    expect(evaluateHealth(restarted(45_000))).toEqual(STARTING);
    expect(evaluateHealth(restarted(60_000))).toEqual(STARTING);
    expect(evaluateHealth(restarted(61_000))).toEqual({
      state: "stalled",
      healthy: false,
      reason: "no new video for 62s",
    });
  });

  it("waits again for a run started again before any video of the one before, within the grace of the last video", () => {
    // Two stalls and a re-encode: the second restart came 35 s after the stream's last frame.
    const second = inputs({
      attemptStartedAt: NOW - 3_600_000,
      pipeline: pipeline({ lastFrameAt: ago(45_000), restartedAt: ago(10_000) }),
    });
    expect(evaluateHealth(second)).toEqual(STARTING);
    // One long after the stream's last video counts for nothing: it is stalled.
    const late = inputs({
      attemptStartedAt: NOW - 3_600_000,
      pipeline: pipeline({ lastFrameAt: ago(80_000), restartedAt: ago(5000) }),
    });
    expect(evaluateHealth(late).state).toBe("stalled");
  });

  it("plays once the new run has video of its own, and is stalled when it exits", () => {
    const playing = pipeline({ state: "running", lastFrameAt: ago(1000), restartedAt: ago(5000) });
    expect(evaluateHealth(inputs({ attemptStartedAt: NOW - 3_600_000, pipeline: playing })).state).toBe("playing");
    expect(evaluateHealth(restarted(30_000, { state: "exited", error: "x" })).state).toBe("stalled");
  });

  it("goes by the attempt alone for a stream that never had video, or a transcoder that doesn't say", () => {
    const never = pipeline({ lastFrameAt: null, restartedAt: ago(1000) });
    expect(evaluateHealth(inputs({ attemptStartedAt: NOW - 90_000, pipeline: never })).state).toBe("stalled");
    const older = pipeline({ lastFrameAt: ago(45_000) });
    expect(evaluateHealth(inputs({ pipeline: older })).state).toBe("stalled");
  });
});

function stale(advancedAt: number, behindSeconds = 0, quietSince = advancedAt): LiveEdgeView {
  return {
    state: "stale",
    edgeAt: new Date(advancedAt).toISOString(),
    advancedAt: new Date(advancedAt).toISOString(),
    quietSince: new Date(quietSince).toISOString(),
    behindSeconds,
  };
}

describe("a broadcast that changes its layout mid-stream", () => {
  it("counts the time without video from the change, while the transcoder starts on the new layout", () => {
    // The broadcast paused before it moved its video: the last frame is older than a stall takes.
    const changed = pipeline({ state: "starting", lastFrameAt: ago(45_000), layoutChangedAt: ago(5000) });
    expect(lastSignOfVideo(changed)).toBe(NOW - 5000);
    expect(evaluateHealth(inputs({ pipeline: changed }))).toEqual({
      state: "playing",
      healthy: true,
      reason: "receiving video",
    });
  });

  it("is stalled when no video came of the change either, for as long as players got none", () => {
    const quiet = pipeline({ state: "starting", lastFrameAt: ago(70_000), layoutChangedAt: ago(25_000) });
    expect(evaluateHealth(inputs({ pipeline: quiet }))).toEqual({
      state: "stalled",
      healthy: false,
      reason: "no new video for 70s",
    });
  });

  it("allows nothing for a change whose ffmpeg run failed", () => {
    const failed = pipeline({
      state: "exited",
      error: "Conversion failed!",
      lastFrameAt: ago(30_000),
      layoutChangedAt: ago(5000),
    });
    expect(lastSignOfVideo(failed)).toBe(NOW - 30_000);
    expect(evaluateHealth(inputs({ pipeline: failed }))).toEqual({
      state: "stalled",
      healthy: false,
      reason: "pipeline exited: Conversion failed!",
    });
  });

  it("makes no difference once video came after it", () => {
    const longAgo = ago(3_600_000);
    const playing = pipeline({ lastFrameAt: ago(5000), layoutChangedAt: longAgo });
    expect(lastSignOfVideo(playing)).toBe(NOW - 5000);
    expect(evaluateHealth(inputs({ pipeline: playing })).state).toBe("playing");
    const stopped = pipeline({ lastFrameAt: ago(45_000), layoutChangedAt: longAgo });
    expect(evaluateHealth(inputs({ pipeline: stopped }))).toMatchObject({
      state: "stalled",
      reason: "no new video for 45s",
    });
  });

  it("takes a transcoder that doesn't report layout changes yet as one whose stream had none", () => {
    // An older transcoder's status has no such field at all.
    const older = pipeline({ lastFrameAt: ago(5000) });
    delete older.layoutChangedAt;
    expect(lastSignOfVideo(older)).toBe(NOW - 5000);
    expect(evaluateHealth(inputs({ pipeline: older }))).toEqual({
      state: "playing",
      healthy: true,
      reason: "receiving video",
    });
  });

  it("is no sign of video for a stream that showed none yet", () => {
    const starting = pipeline({ state: "starting", layoutChangedAt: ago(1000) });
    expect(lastSignOfVideo(starting)).toBeUndefined();
    expect(lastSignOfVideo(undefined)).toBeUndefined();
    expect(evaluateHealth(inputs({ pipeline: starting }))).toMatchObject({ state: "starting", healthy: false });
  });
});

describe("a source whose engine serves a broadcast that goes on too far behind", () => {
  // The edge moved 2 s ago and the broadcast sent new data then: only the engine is 103 s late.
  const lagging = { ...stale(NOW - 2000, 103), staleBecause: "behind" as const };

  it("is stalled, not a stale source: the broadcast is there, and a new engine fixes it", () => {
    const stopped = pipeline({ state: "exited", error: "stopped reading", liveEdge: lagging });
    expect(evaluateHealth(inputs({ pipeline: stopped }))).toEqual({
      state: "stalled",
      healthy: false,
      reason: "the engine serves the broadcast 103s late",
      lagging: true,
    });
  });

  it("is a stale source when the transcoder says the broadcast is quiet, or doesn't say why", () => {
    for (const staleBecause of ["quiet", null, undefined] as const) {
      const liveEdge = {
        ...stale(NOW - 2000, 103, NOW - 660_000),
        ...(staleBecause !== undefined && { staleBecause }),
      };
      const health = evaluateHealth(inputs({ pipeline: pipeline({ liveEdge }) }));
      expect(health).toEqual({
        state: "stale-source",
        healthy: false,
        reason: "no new data from the broadcast for 11m",
      });
    }
  });
});

describe("a source whose live edge stopped", () => {
  it("is a stale source, before any other reading of the pipeline", () => {
    const stopped = pipeline({ state: "exited", error: "stopped reading", liveEdge: stale(NOW - 2_242_000) });
    expect(evaluateHealth(inputs({ pipeline: stopped }))).toEqual({
      state: "stale-source",
      healthy: false,
      reason: "no new data from the broadcast for 37m",
    });
  });

  it("counts how long the broadcast sent nothing new from when it last did, not from a retry's own edge", () => {
    // A retry's session started 61 s ago on a slightly later end of the old window, but the
    // broadcast has been quiet for 11 minutes.
    const retried = pipeline({ liveEdge: stale(NOW - 61_000, 0, NOW - 660_000) });
    expect(evaluateHealth(inputs({ pipeline: retried })).reason).toBe("no new data from the broadcast for 11m");
  });

  it("says when the engine serves far behind the live edge of a broadcast not known to send new data", () => {
    const late = pipeline({ liveEdge: stale(NOW - 1000, 75) });
    expect(evaluateHealth(inputs({ pipeline: late }))).toMatchObject({
      state: "stale-source",
      reason: "the engine serves the broadcast 75s late, and the broadcast is not known to send new data",
    });
  });

  it("waits for video while a new source's live edge has not moved yet", () => {
    const waiting = pipeline({
      liveEdge: { state: "waiting", edgeAt: null, advancedAt: null, quietSince: null, behindSeconds: null },
    });
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
