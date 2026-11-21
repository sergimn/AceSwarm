import type { Generation } from "./generation.ts";
import type { PipelineEvents } from "./pipeline-settings.ts";
import type { LayoutChangeKind } from "./ts-tables.ts";

/**
 * What a stream's pipeline tells of the layout changes of the source players get: how often they
 * come (see `PipelineEvents.layoutChanged`), and how long players went without new video at each
 * (see `Generation.show`). Only changes that ffmpeg had to follow count: a new run took over, or
 * the same one read on over a move to other PIDs. Tables that change around the streams ffmpeg
 * reads don't: a broadcast can send such changes every second for as long as it lasts.
 */
export class LayoutChanges {
  private readonly id: string;
  private readonly events: PipelineEvents;
  private readonly now: () => number;

  constructor(id: string, events: PipelineEvents, now: () => number) {
    this.id = id;
    this.events = events;
    this.now = now;
  }

  /**
   * The broadcast changed its layout under the stream's active run: `run` goes on with it, a new
   * one (`new`) or the same (`same`). Its first frame that players get after now ends the wait.
   */
  changed(run: Generation, kind: LayoutChangeKind, how: "new" | "same"): void {
    run.gapSince = this.now();
    this.events.layoutChanged(this.id, kind, how);
  }

  /** Players can get the run's newest frame now (see `Generation.show`). */
  shown(run: Generation): void {
    const gap = run.show();
    if (gap !== undefined) {
      this.waited(gap);
    }
  }

  /** Players got the first frame after a change, so many ms after the last one before it. */
  waited(ms: number): void {
    this.events.layoutGap(this.id, ms);
  }
}
