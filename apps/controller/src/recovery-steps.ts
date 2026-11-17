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

/**
 * A stream's recovery steps: counts every step it takes, and the recoveries that brought its video
 * back.
 *
 * A recovery succeeded when the stream plays again after one or more steps. It counts once then,
 * under the last step that changed where the stream plays from; the steps before it are only
 * attempts. A step that fails and leaves the stream on the session it had (a path switch or a
 * failover whose new engine brought no video in time) changed nothing: the step before it keeps
 * the credit, unless that engine's video arrives late and the stream moves to it after all. A step
 * that stopped the stream's session keeps the credit even when it fails, because the starts that
 * follow finish what it began.
 *
 * Whether the step or the swarm brought the video back can't be told apart, so "succeeded" means
 * no more than that video came back after it.
 */
export class RecoverySteps {
  private readonly stream: string;
  private readonly metrics: ControllerMetrics;
  private count = 0;
  /** The step that counts as succeeded once the stream plays. */
  private credited: RecoveryStep | undefined;
  /** The step that runs now: what was credited before it, and the session the stream had then. */
  private running: { before: RecoveryStep | undefined; session: EngineSession | undefined } | undefined;
  /** The step whose move failed last, while its video may still arrive late. */
  private gaveUp: RecoveryStep | undefined;

  constructor(stream: string, metrics: ControllerMetrics) {
    this.stream = stream;
    this.metrics = metrics;
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

  /** A step starts, for a stream that plays from `session`. */
  took(step: RecoveryStep, session: EngineSession | undefined): void {
    this.count += 1;
    this.metrics.recoveries.inc({ stream: this.stream, action: step });
    this.running = { before: this.credited, session };
    this.credited = step;
    this.gaveUp = undefined;
  }

  /** The step that started last failed, and the stream plays from `session` now. */
  failed(session: EngineSession | undefined): void {
    const { running } = this;
    this.running = undefined;
    if (running === undefined || session === undefined || session !== running.session) {
      return;
    }
    this.gaveUp = this.credited;
    this.credited = running.before;
  }

  /** The stream moved to the engine a failed move had started: its video arrived late. */
  arrivedLate(): void {
    this.credited = this.gaveUp ?? this.credited;
    this.gaveUp = undefined;
  }

  /** The stream plays: the step that brought its video back succeeded. */
  played(): void {
    if (this.credited !== undefined) {
      this.metrics.recoveriesSucceeded.inc({ stream: this.stream, action: this.credited });
    }
    this.credited = undefined;
    this.running = undefined;
    this.gaveUp = undefined;
  }
}
