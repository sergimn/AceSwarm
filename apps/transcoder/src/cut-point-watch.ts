/** MPEG-TS time stamps: 90 kHz, 33 bits, so they wrap around about every 26.5 hours. */
const TICKS_PER_MS = 90;
const WRAP = 2 ** 33;

/** How far apart a copy's cut points may come at most for the copy to come back, as long as that is under half the stall time. */
export const MAX_CUT_GAP_MS = 10_000;
/** How long cut points have to keep coming that often before the first return to copy. */
export const STEADY_MS = 60_000;
/** The longest wait for a return: each return that ended in a re-encode again doubles it, up to this. */
export const MAX_STEADY_MS = 30 * 60_000;

/** How far `to` is after `from`, in ms, across a wrap of the 33-bit time stamps; negative when it is before. */
function msBetween(from: number, to: number): number {
  const ticks = (((to - from) % WRAP) + WRAP) % WRAP;
  return (ticks >= WRAP / 2 ? ticks - WRAP : ticks) / TICKS_PER_MS;
}

/**
 * Decides when a stream whose full output is re-encoded because a copy of its video couldn't be cut
 * (see `SourceFeeds.copyFails`) can copy it again: once its broadcast sends access units ffmpeg
 * can cut a copy at (see `cutPointOf`) often enough, and has done so for a while.
 *
 * It goes by the time stamps of those units, not by when they arrive: an engine sends what it has
 * buffered faster than real time when a session starts, which would make cut points look closer
 * together than they are. A unit without a time stamp, one more than the gap allowed after the last
 * (a pause, or a jump in the time stamps) or one before it starts the count over.
 */
export class CutPointWatch {
  private readonly maxGapMs: number;
  private steadyMs = STEADY_MS;
  /** The time stamp of the first and of the last cut point of the run that is counting. */
  private since: number | undefined;
  private last: number | undefined;

  /** `stallMs`: the stall time of the full output (`FULL_OUTPUT_STALL_SECONDS`), which the gap has to stay well under. */
  constructor(stallMs: number) {
    this.maxGapMs = Math.min(MAX_CUT_GAP_MS, stallMs / 2);
  }

  /** How long cut points have to keep coming before the next return. */
  get waitMs(): number {
    return this.steadyMs;
  }

  /** A cut point came, with its PES's time stamp (90 kHz) if it had one. Returns whether the copy can come back at it. */
  cutPoint(pts: number | undefined): boolean {
    if (pts === undefined) {
      this.reset();
      return false;
    }
    const gap = this.last === undefined ? undefined : msBetween(this.last, pts);
    if (this.since === undefined || gap === undefined || gap <= 0 || gap > this.maxGapMs) {
      this.since = pts;
    }
    this.last = pts;
    return msBetween(this.since, pts) >= this.steadyMs;
  }

  /** Starts the count over, as when the copy came back. */
  reset(): void {
    this.since = undefined;
    this.last = undefined;
  }

  /** A return to copy ended in a re-encode again: the next one waits twice as long. */
  failedAgain(): void {
    this.steadyMs = Math.min(this.steadyMs * 2, MAX_STEADY_MS);
    this.reset();
  }
}
