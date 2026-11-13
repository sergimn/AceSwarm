import type { PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient, EngineSession } from "./acestream.ts";
import type { TranscoderClient } from "./clients.ts";
import type { EnginePaths } from "./engine-paths.ts";
import type { EngineHandle } from "./engines.ts";
import { handOverTo, type HandoverTiming } from "./playback.ts";
import type { SharedEngines } from "./shared-engines.ts";
import type { StreamStandbys, TakenStandby } from "./standby.ts";
import type { MovedStream } from "./stream-engines.ts";

/** What a failover needs from the stream's engines (see `StreamEngines`). */
export interface FailoverHost {
  streamId: string;
  logger: Logger;
  /** The gateway paths of the engines of the stream's own that it plays from. */
  gateway: EnginePaths;
  standbys: StreamStandbys;
  transcoder: TranscoderClient;
  ace: AcestreamClient;
  shared: SharedEngines | undefined;
  /** Saves the engine the stream plays from, for a restarted controller. */
  remember: (engine: EngineHandle) => Promise<EngineHandle>;
  /** Lets go of an engine: leaves a shared one, removes one of its own. */
  release: (engine: EngineHandle) => Promise<void>;
}

/** Where the stream plays from before a failover, and how to commit it. */
interface FailoverFrom {
  from: EngineHandle;
  /** The path the stream leaves, where an engine of its own stays as the standby. */
  fromPath: string | null;
  /** The stream's session on `from`, stopped once the failover is done. */
  session: EngineSession | undefined;
  /** Runs once the stream plays from the standby's engine on its path, before the old engine becomes a standby. */
  commit: (moved: MovedStream, path: string) => Promise<void>;
}

/** A failover to a standby: see `failOverTo`. */
export interface EngineFailover extends FailoverFrom {
  standby: TakenStandby;
  handover: HandoverTiming;
}

/** A failover that may have delivered after it gave up: see `finishLateFailover`. */
export interface LateFailover extends FailoverFrom {
  pipeline: PipelineStatus | undefined;
}

/**
 * Moves the stream to a standby (see `StreamStandbys`), make-before-break: the transcoder keeps
 * the current picture until the standby's session delivers video, which a hot standby does within
 * seconds. The engine the stream leaves becomes the standby on its path when it is one of the
 * stream's own; a shared one keeps playing its other streams, and gets a standby session later.
 * A failover that fails puts the standby back, and no failover tries it again for a while.
 */
export async function failOverTo(host: FailoverHost, failover: EngineFailover): Promise<void> {
  const { standby } = failover;
  let pipeline: PipelineStatus;
  try {
    pipeline = await handOverTo(host.transcoder, host.streamId, standby.session, false, failover.handover);
  } catch (error) {
    host.standbys.restore(standby);
    throw error;
  }
  await finish(host, failover, standby, pipeline);
}

/**
 * The transcoder plays from a standby's session: a failover to it gave up waiting, and its video
 * arrived later. Finishes that failover. Returns true then.
 */
export async function finishLateFailover(host: FailoverHost, late: LateFailover): Promise<boolean> {
  const { pipeline } = late;
  if (pipeline?.lastFrameAt === null || pipeline === undefined || pipeline.source === late.session?.playbackUrl) {
    return false;
  }
  const standby = host.standbys.takeBySource(pipeline.source);
  if (standby === undefined) {
    return false;
  }
  host.logger.info({ engine: standby.engine.name }, "video arrived late from the standby; failing over to it");
  await finish(host, late, standby, pipeline);
  return true;
}

async function finish(
  host: FailoverHost,
  failover: FailoverFrom,
  standby: TakenStandby,
  pipeline: PipelineStatus,
): Promise<void> {
  const { from } = failover;
  const engine = standby.engine;
  host.standbys.promoted(standby);
  if (engine.sharedPath === null) {
    host.gateway.adopt(engine.ip, standby.path);
  } else {
    host.shared?.promote(engine, host.streamId);
  }
  // First, so that a restarted controller takes over the engine the transcoder already plays from.
  await host.remember(engine);
  await failover.commit({ engine, session: standby.session, pipeline }, standby.path);
  if (failover.session !== undefined) {
    await host.ace.stopSession(failover.session.commandUrl).catch(() => undefined);
  }
  if (from.containerId === engine.containerId) {
    return;
  }
  if (from.sharedPath === null && failover.fromPath !== null) {
    host.gateway.forget(from.ip);
    await host.standbys.adopt(failover.fromPath, from);
    return;
  }
  await host.release(from).catch((error: unknown) => {
    host.logger.warn({ err: error, engine: from.name }, "could not let go of the engine the stream left");
  });
}
