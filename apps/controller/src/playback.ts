import { randomUUID } from "node:crypto";
import type { PipelineStatus } from "@aceswarm/shared/api-types";
import { kindsToTry, type AceIdKind } from "@aceswarm/shared/ace-id";
import { EngineError, type AcestreamClient, type EngineSession } from "./acestream.ts";
import type { TranscoderClient } from "./clients.ts";

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

/**
 * Waits until the transcoder has cut a stream over to `source` (a make-before-break move) and
 * video arrives from it. Returns the pipeline's status then; throws when the new source stops
 * first or takes longer than the timeout.
 */
export async function waitForHandover(
  transcoder: TranscoderClient,
  id: string,
  source: string,
  timing: HandoverTiming,
): Promise<PipelineStatus> {
  const deadline = timing.now() + timing.timeoutMs;
  while (timing.now() < deadline) {
    await timing.sleep(timing.pollMs);
    const status = await transcoder.status(id).catch(() => undefined);
    if (status?.source === source && status.lastFrameAt !== null) {
      return status;
    }
    if (status !== undefined && status.pendingSource !== source && status.source !== source) {
      throw new Error("the new path stopped before delivering video");
    }
  }
  throw new Error("the new path did not deliver video in time");
}
