import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { PipelineStatus } from "@aceswarm/shared/api-types";
import { kindsToTry, type AceIdKind } from "@aceswarm/shared/ace-id";
import { EngineError, type AcestreamClient, type EngineSession } from "./acestream.ts";
import type { TranscoderClient } from "./clients.ts";

export async function sleep(ms: number): Promise<void> {
  await wait(ms);
}

/** The pipeline as exited, for one the transcoder no longer knows (for example after it restarted). */
export function exitedPipeline(previous: PipelineStatus | undefined, error: string): PipelineStatus | undefined {
  return previous === undefined ? undefined : { ...previous, state: "exited", error };
}

/**
 * Starts an engine session. A bare 40 character value can be a content ID or an infohash, and
 * the engine rejects the wrong kind quickly, so the other kind is tried next. Returns the kind
 * that worked, for the caller to remember.
 */
export async function startSessionOfAnyKind(
  ace: AcestreamClient,
  baseUrl: string,
  aceId: string,
  known: AceIdKind | null,
): Promise<{ session: EngineSession; kind: AceIdKind }> {
  let lastError: unknown;
  for (const kind of kindsToTry(known)) {
    try {
      return { session: await ace.startSession(baseUrl, aceId, kind, randomUUID()), kind };
    } catch (error) {
      if (!(error instanceof EngineError)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

export interface HandoverTiming {
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The transcoder's ffmpeg for a move's new source exited before video came from it. */
export class SourceExitedError extends Error {}

/**
 * Waits until the transcoder has cut a stream over to `source` (a make-before-break move) and
 * video arrives from it. Returns the pipeline's status then; throws when the new source stops
 * first (`SourceExitedError` once its ffmpeg exited) or takes longer than the timeout.
 */
export async function waitForHandover(
  transcoder: TranscoderClient,
  id: string,
  source: string,
  timing: HandoverTiming,
): Promise<PipelineStatus> {
  const deadline = timing.now() + timing.timeoutMs;
  // Checks in a row that found its ffmpeg exited: a transcode relaunch shows one for a moment.
  let exited = 0;
  while (timing.now() < deadline) {
    await timing.sleep(timing.pollMs);
    const status = await transcoder.status(id).catch(() => undefined);
    if (status?.source === source && status.lastFrameAt !== null) {
      return status;
    }
    if (status !== undefined && status.pendingSource !== source && status.source !== source) {
      throw new Error("the new engine stopped before delivering video");
    }
    exited = status?.source === source && status.state === "exited" ? exited + 1 : 0;
    if (exited === 2) {
      throw new SourceExitedError("the transcoder stopped reading the new engine before it delivered video");
    }
  }
  throw new Error("the new path did not deliver video in time");
}

/** Whether the transcoder's current ffmpeg still reads the session (an engine allows one reader). */
async function transcoderReads(transcoder: TranscoderClient, id: string, session: EngineSession): Promise<boolean> {
  const status = await transcoder.status(id).catch(() => undefined);
  return status?.source === session.playbackUrl && status.state !== "exited";
}

/**
 * Starts the transcoder's handover to `session` and waits for its video. A `reused` session the
 * transcoder still reads gets no second reader, unless that one gives up first (its input timeout).
 */
export async function handOverTo(
  transcoder: TranscoderClient,
  id: string,
  session: EngineSession,
  reused: boolean,
  timing: HandoverTiming,
): Promise<PipelineStatus> {
  const source = session.playbackUrl;
  if (reused && (await transcoderReads(transcoder, id, session))) {
    try {
      return await waitForHandover(transcoder, id, source, timing);
    } catch (error) {
      if (!(error instanceof SourceExitedError)) {
        throw error;
      }
    }
  }
  await transcoder.start(id, { source }, true);
  return waitForHandover(transcoder, id, source, timing);
}
