import type { PipelineStatus } from "@aceswarm/shared/api-types";
import type { EngineSession } from "./acestream.ts";
import type { ControllerMetrics } from "./metrics.ts";
import type { RecoveryAction } from "./recovery.ts";

/** A step that tries to bring a stream's video back: one of the ladder's, or a failover to a hot standby. */
export type RecoveryStep = RecoveryAction | "failover";

export const RECOVERY_STEPS: readonly RecoveryStep[] = [
  "restart-pipeline",
  "restart-engine",
  "switch-path",
  "failover",
];

/** Where a stream plays from, as its supervisor knows it: its session, and what its transcoder reads. */
export interface PlayedFrom {
  session: EngineSession | undefined;
  /** Undefined while the transcoder's pipeline is unknown. */
  pipeline: Pick<PipelineStatus, "source"> | undefined;
}

/**
 * A stream's recovery steps: counts every step it takes, and the recoveries that brought its video
 * back.
 *
 * A recovery succeeded when the stream plays again after one or more steps. It counts once then,
 * under the last step that changed where the stream plays from; the steps before it are only
 * attempts. A step that failed changed nothing when the stream plays from the session it had (a
 * path switch or a failover whose new engine brought no video in time), or from a new session its
 * transcoder doesn't read (the transcoder could not start): the step before it keeps the credit.
 * Should the video of a move that gave up arrive late, and the stream move to it after all, the
 * step that started that move gets the credit. A step that stopped the stream's session keeps the
 * credit even when it fails, because the starts that follow finish what it began.
 *
 * Whether the step or the swarm brought the video back can't be told apart, so "succeeded" means
 * no more than that video came back after it.
 */
export class RecoverySteps {
  private readonly stream: string;
  private readonly metrics: ControllerMetrics;
  private readonly playing: () => PlayedFrom;
  private count = 0;
  /** The step that counts as succeeded once the stream plays. */
  private credited: RecoveryStep | undefined;
  /** The step that runs now. */
  private running: RecoveryStep | undefined;
  /**
   * The steps that handed the stream over to a session, by its playback URL, until it plays: the
   * video of a move that gave up may still arrive (see `arrivedLate`).
   */
  private readonly handovers = new Map<string, RecoveryStep>();

  constructor(stream: string, metrics: ControllerMetrics, playing: () => PlayedFrom) {
    this.stream = stream;
    this.metrics = metrics;
    this.playing = playing;
    // From zero, so that a rate sees the first one too: Prometheus counts no increase for a series
    // that first shows up with a value.
    for (const action of RECOVERY_STEPS) {
      metrics.recoveries.inc({ stream, action }, 0);
      metrics.recoveriesSucceeded.inc({ stream, action }, 0);
    }
  }

  /** Steps taken since the stream was started, whether or not they helped (the stream's `recoveries`). */
  get taken(): number {
    return this.count;
  }

  /** Takes `step`, which `run` carries out. Throws what `run` throws. */
  async take(step: RecoveryStep, run: () => Promise<void>): Promise<void> {
    const before = this.credited;
    const { session } = this.playing();
    this.count += 1;
    this.metrics.recoveries.inc({ stream: this.stream, action: step });
    this.credited = step;
    this.running = step;
    try {
      await run();
    } catch (error) {
      const now = this.playing();
      // It changed nothing: the stream plays from the session it had, or from one its transcoder doesn't read.
      if (now.session !== undefined && (now.session === session || now.pipeline?.source !== now.session.playbackUrl)) {
        this.credited = before;
      }
      throw error;
    } finally {
      this.running = undefined;
    }
  }

  /**
   * A move starts handing the stream over to `session`. One that no step runs (a move the policy
   * asked for) gets no credit should its video arrive late.
   */
  readonly handingOver = (session: EngineSession): void => {
    if (this.running === undefined) {
      this.handovers.delete(session.playbackUrl);
    } else {
      this.handovers.set(session.playbackUrl, this.running);
    }
  };

  /** The stream moved to `session` after its move gave up: that move's video arrived late. */
  arrivedLate(session: EngineSession): void {
    this.credited = this.handovers.get(session.playbackUrl) ?? this.credited;
  }

  /** The stream plays: the step that brought its video back succeeded. */
  played(): void {
    if (this.credited !== undefined) {
      this.metrics.recoveriesSucceeded.inc({ stream: this.stream, action: this.credited });
    }
    this.credited = undefined;
    this.handovers.clear();
  }
}
