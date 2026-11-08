import type { LiveEdgeView, PipelineStatus } from "@aceswarm/shared/api-types";

export type HealthState = "starting" | "buffering" | "playing" | "stalled" | "stale-source";

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

/** A duration for people: seconds up to two minutes, then minutes, then hours and minutes. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 120) {
    return `${String(total)}s`;
  }
  const minutes = Math.floor(total / 60);
  return minutes < 120 ? `${String(minutes)}m` : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/** Why a source whose live edge the transcoder found stale is. */
function staleReason(edge: LiveEdgeView, now: number): string {
  const behind = edge.behindSeconds ?? 0;
  const since = edge.advancedAt === null ? undefined : Date.parse(edge.advancedAt);
  return since !== undefined && now - since > behind * 1000
    ? `no new data from the broadcast for ${duration(now - since)}`
    : `the engine serves the broadcast ${duration(behind * 1000)} late`;
}

/**
 * Classifies a stream from what the pipeline and engine report. A stream is healthy only while
 * new video frames keep arriving; everything else is either still starting or stalled. Frames
 * only count while the engine's live edge moves (the transcoder publishes nothing else), and a
 * source whose live edge stopped is "stale-source": its broadcast sends nothing new, so restarting
 * things locally can't bring video back.
 */
export function evaluateHealth(inputs: HealthInputs): Health {
  const { now, pipeline } = inputs;
  if (pipeline?.liveEdge?.state === "stale") {
    return { state: "stale-source", healthy: false, reason: staleReason(pipeline.liveEdge, now) };
  }
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
