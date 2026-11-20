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
  /**
   * No video because the engine serves the broadcast too far behind its live edge, while the
   * broadcast sends new data (`LiveEdgeView.staleBecause` is "behind"). That is the engine's
   * doing, which a new one fixes: the stream doesn't wait for its broadcast.
   */
  lagging?: true;
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

/**
 * Why a source whose live edge the transcoder found stale is. How long the broadcast sent nothing
 * new counts from `quietSince`, which goes on when a retry opens a session on a newer window. A
 * session that is stale for how far behind its engine serves, rather than for that long without
 * new data, says so, with what makes the stream wait all the same: nobody saw the broadcast send
 * new data lately (otherwise it is `lagging`, see `evaluateHealth`).
 */
function staleReason(edge: LiveEdgeView, now: number): string {
  const behind = edge.behindSeconds ?? 0;
  const since = edge.quietSince === null ? undefined : Date.parse(edge.quietSince);
  return since !== undefined && now - since > behind * 1000
    ? `no new data from the broadcast for ${duration(now - since)}`
    : `${lateReason(edge)}, and the broadcast is not known to send new data`;
}

function lateReason(edge: LiveEdgeView): string {
  return `the engine serves the broadcast ${duration((edge.behindSeconds ?? 0) * 1000)} late`;
}

/**
 * When the stream last showed that it has video: its last new frame, or after that, the moment its
 * broadcast changed layout mid-stream (see `PipelineStatus.layoutChangedAt`). A broadcast that
 * moves its video to another PID or codec often sends nothing for a while first, and the
 * transcoder then needs a few seconds to show video from the new layout. The change itself tells
 * that the broadcast is back, so the time without frames counts from it: the stream is not taken
 * for stalled, or moved to a standby, for a pause that the transcoder is already getting over.
 * The transcoder only reports a change that followed video (a run that showed frames of its own),
 * so tables that keep changing over a stream without video don't hold a stall off.
 * Undefined while the stream showed no video yet.
 */
export function lastSignOfVideo(pipeline: PipelineStatus | undefined): number | undefined {
  if (pipeline === undefined || pipeline.lastFrameAt === null) {
    return undefined;
  }
  const frame = Date.parse(pipeline.lastFrameAt);
  const { layoutChangedAt, state } = pipeline;
  // Once the run that took over failed, nothing is coming of the change.
  return layoutChangedAt === null || state === "exited" ? frame : Math.max(frame, Date.parse(layoutChangedAt));
}

/**
 * When the transcoder started the stream's ffmpeg again by itself (see `PipelineStatus.restartedAt`)
 * after the stream's last video, and within the startup grace of that video. Its new run starts like
 * one the controller started: it may take a while, as a broadcast whose copy can't be cut takes two
 * restarts and a re-encode. Undefined otherwise. A restart long after the stream's last video counts
 * for nothing: a run that makes no video of its own gets that wait from each restart only while the
 * restart is within the grace of the stream's last video, so at most about twice the grace in all.
 */
function restartedAfterVideo(
  pipeline: PipelineStatus | undefined,
  lastFrame: number | undefined,
  graceMs: number,
): number | undefined {
  const restartedAt = pipeline?.restartedAt;
  if (restartedAt === undefined || restartedAt === null || lastFrame === undefined) {
    return undefined;
  }
  const at = Date.parse(restartedAt);
  return at >= lastFrame && at - lastFrame <= graceMs ? at : undefined;
}

/**
 * Classifies a stream from what the pipeline and engine report. A stream is healthy only while
 * new video frames keep arriving; everything else is either still starting or stalled. Frames
 * only count while the engine's live edge moves (the transcoder publishes nothing else), and a
 * source whose live edge stopped is "stale-source": its broadcast sends nothing new, so restarting
 * things locally can't bring video back. A source that is stale only because its engine serves a
 * broadcast that goes on too far behind (`lagging`) is stalled instead: that is local, and a new
 * engine fixes it. (A transcoder that doesn't say why a source is stale gets the wait, as before.)
 * A stream whose transcoder started ffmpeg again by itself after its video is starting (see
 * `restartedAfterVideo`): neither a stall nor a reason to fail over to a standby early.
 */
export function evaluateHealth(inputs: HealthInputs): Health {
  const { now, pipeline } = inputs;
  const edge = pipeline?.liveEdge;
  if (edge?.state === "stale") {
    return edge.staleBecause === "behind"
      ? { state: "stalled", healthy: false, reason: lateReason(edge), lagging: true }
      : { state: "stale-source", healthy: false, reason: staleReason(edge, now) };
  }
  const lastFrame = lastSignOfVideo(pipeline);
  const restartedAt = restartedAfterVideo(pipeline, lastFrame, inputs.startupGraceMs);
  if (restartedAt !== undefined && pipeline?.state !== "exited" && now - restartedAt <= inputs.startupGraceMs) {
    return { state: "starting", healthy: false, reason: "the transcoder started ffmpeg again; waiting for video" };
  }
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
    // How long players really got nothing new: a layout change in between brought no frame.
    const frame = Date.parse(pipeline?.lastFrameAt ?? "");
    return { state: "stalled", healthy: false, reason: `no new video for ${seconds(now - frame)}` };
  }
  const elapsed = now - inputs.attemptStartedAt;
  if (elapsed <= inputs.startupGraceMs) {
    return inputs.engineStatus === "prebuf"
      ? { state: "buffering", healthy: false, reason: "engine is buffering" }
      : { state: "starting", healthy: false, reason: "waiting for video" };
  }
  return { state: "stalled", healthy: false, reason: `no video after ${seconds(elapsed)}` };
}
