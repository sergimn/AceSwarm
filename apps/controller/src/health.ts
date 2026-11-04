import type { PipelineStatus } from "@aceswarm/shared/api-types";

export type HealthState = "starting" | "buffering" | "playing" | "stalled";

export interface HealthInputs {
  now: number;
  /** When the current playback attempt (session + pipeline) started. */
  attemptStartedAt: number;
  pipeline: PipelineStatus | undefined;
  /** Engine session status: "prebuf" while buffering, "dl" while downloading. */
  engineStatus: string | undefined;
  stallAfterMs: number;
  startupGraceMs: number;
}

export interface Health {
  state: HealthState;
  healthy: boolean;
  reason: string;
}

function seconds(ms: number): string {
  return `${String(Math.round(ms / 1000))}s`;
}

/**
 * Classifies a stream from what the pipeline and engine report. A stream is healthy only while
 * new video frames keep arriving; everything else is either still starting or stalled.
 */
export function evaluateHealth(inputs: HealthInputs): Health {
  const { now, pipeline } = inputs;
  const lastFrame =
    pipeline?.lastFrameAt === null || pipeline === undefined ? undefined : Date.parse(pipeline.lastFrameAt);

  if (lastFrame !== undefined && now - lastFrame <= inputs.stallAfterMs) {
    return { state: "playing", healthy: true, reason: "receiving video" };
  }
  if (pipeline?.state === "exited") {
    return {
      state: "stalled",
      healthy: false,
      reason: `pipeline exited${pipeline.error === null ? "" : `: ${pipeline.error}`}`,
    };
  }
  if (lastFrame !== undefined) {
    return { state: "stalled", healthy: false, reason: `no new video for ${seconds(now - lastFrame)}` };
  }
  const elapsed = now - inputs.attemptStartedAt;
  if (elapsed <= inputs.startupGraceMs) {
    return inputs.engineStatus === "prebuf"
      ? { state: "buffering", healthy: false, reason: "engine is buffering" }
      : { state: "starting", healthy: false, reason: "waiting for video" };
  }
  return { state: "stalled", healthy: false, reason: `no video after ${seconds(elapsed)}` };
}
