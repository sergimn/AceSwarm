import type { Logger } from "@aceswarm/shared/logger";
import { waitAtMost } from "./playback.ts";
import { StepWatch } from "./step-watch.ts";

export interface StepLoopOptions {
  /** How long to wait between the end of one step and the start of the next. */
  delayMs: number;
  now: () => number;
  logger: Logger;
  /** One supervision step. A step that throws is logged, and the loop goes on. */
  step: () => Promise<void>;
  /** Brings what the stream shows up to date while a step takes long (see `StepWatch`). */
  observe: () => Promise<void>;
}

/**
 * Runs a stream's supervision steps one after another, `delayMs` apart, and has the stream
 * observed while one of them takes long.
 */
export class StepLoop {
  private readonly options: StepLoopOptions;
  private readonly watch: StepWatch;
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> = Promise.resolve();
  private active = false;

  constructor(options: StepLoopOptions) {
    this.options = options;
    this.watch = new StepWatch(options.delayMs, options.now, options.logger, options.observe);
  }

  get running(): boolean {
    return this.active;
  }

  /** The first step runs at once. */
  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.watch.start();
    this.schedule(0);
  }

  /**
   * No step starts after this. Waits at most `waitMs` for the one in progress: a step can take
   * minutes, and what it leaves the next run takes over.
   */
  async stop(waitMs: number): Promise<void> {
    this.active = false;
    clearTimeout(this.timer);
    this.watch.stop();
    await waitAtMost(this.current, waitMs);
  }

  private schedule(delayMs: number): void {
    if (!this.active) {
      return;
    }
    this.timer = setTimeout(() => {
      this.current = this.watch
        .during(this.options.step)
        .catch((error: unknown) => {
          this.options.logger.error({ err: error }, "supervisor tick failed");
        })
        .finally(() => {
          this.schedule(this.options.delayMs);
        });
    }, delayMs);
  }
}
