import type { Logger } from "@aceswarm/shared/logger";

/**
 * Observes a stream while one of its supervision steps takes long. A supervisor runs one step at a
 * time, and a step can wait for minutes (an engine starting, a session opening, a handover waiting
 * for video), while the stream plays on from the engine it has. Without this, the stream would show
 * what it did before the step: its last video, peers and speed freeze, and its standbys stop
 * counting as hot. A step shorter than `everyMs` is left to the next check.
 */
export class StepWatch {
  private readonly everyMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly observe: () => Promise<void>;
  private since: number | undefined;
  private observing = false;
  private timer: NodeJS.Timeout | undefined;

  /**
   * `observe` brings what the stream shows up to date, as a check would, and decides nothing. It
   * runs every `everyMs` while a step has taken that long, and not again before it is done.
   */
  constructor(everyMs: number, now: () => number, logger: Logger, observe: () => Promise<void>) {
    this.everyMs = everyMs;
    this.now = now;
    this.logger = logger;
    this.observe = observe;
  }

  /** Runs `step`, which `check` takes for a long one once it has run for `everyMs`. */
  async during<T>(step: () => Promise<T>): Promise<T> {
    this.since = this.now();
    try {
      return await step();
    } finally {
      this.since = undefined;
    }
  }

  start(): void {
    this.timer ??= setInterval(() => {
      void this.check();
    }, this.everyMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Observes the stream when a step has run for `everyMs` and the last observation is done. */
  async check(): Promise<void> {
    if (this.since === undefined || this.observing || this.now() - this.since < this.everyMs) {
      return;
    }
    this.observing = true;
    try {
      await this.observe();
    } catch (error) {
      this.logger.warn({ err: error }, "could not observe the stream during a long step");
    } finally {
      this.observing = false;
    }
  }
}
