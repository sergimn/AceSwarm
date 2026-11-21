/**
 * A stream whose layout changes again this soon after a reader started over on it waits until
 * then, and gets the layout it has by then. A change is followed at once; tables that flip on
 * after it make the reader start over once more, for what they say when the wait is over, not at
 * every flip.
 */
const MIN_FOLLOW_INTERVAL_MS = 3000;
/**
 * Tables that said the same for this long have settled. Until they do, every change that is
 * followed doubles the wait above, up to this long: tables that never settle get a new start
 * once a minute in the end, not every three seconds for as long as they go on.
 */
const SETTLED_MS = 60_000;

/**
 * Holds back how often a reader starts over on a stream whose program tables keep changing (see
 * `TsTables`). Starting over costs an ffmpeg start, and a few seconds without video for players
 * when it is the pipeline's: a broadcast whose tables flip back and forth must not cause one at
 * every flip.
 */
export class FollowBrake {
  private readonly now: () => number;
  private followedAt = -Infinity;
  /** How many changes were followed since the tables last settled, and when they last changed. */
  private restless = 0;
  private changedAt = -Infinity;

  constructor(now: () => number) {
    this.now = now;
  }

  /** The tables changed. */
  changed(): void {
    // Tables that held long enough before this had settled: the waits start over.
    this.restless = this.now() - this.changedAt >= SETTLED_MS ? 0 : this.restless;
    this.changedAt = this.now();
  }

  /** Whether a change of layout is followed now: the last one that was is long enough ago. */
  mayFollow(): boolean {
    const wait = Math.min(MIN_FOLLOW_INTERVAL_MS * 2 ** Math.max(this.restless - 1, 0), SETTLED_MS);
    return this.now() - this.followedAt >= wait;
  }

  /** The reader starts on a layout now: after a `change`, or on the stream's first one. */
  followed(change: boolean): void {
    this.restless += change ? 1 : 0;
    this.followedAt = this.now();
  }
}
