import { VirtualPlaylist, type OnSegment, type PlaylistSegment } from "./playlist.ts";

/**
 * The slate: a picture that says the stream has no video right now, as a short loop of segments
 * with silent sound (see `makeSlate`). Players outside the page get it in place of the video they
 * wait for.
 */
export interface Slate {
  /** Where its files are. */
  directory: string;
  /** The loop's segments in order, named as a stream's playlists name theirs: relative to the stream. */
  segments: readonly PlaylistSegment[];
}

/** The slate takes over when no segment of the stream came for this long... */
export const SLATE_AFTER_MS = 5000;
/**
 * ...or for this much longer than the longest of the stream's last segments: each comes about as
 * long after the one before it as that one lasts, and a broadcast with few key frames has long ones.
 */
export const SLATE_MARGIN_MS = 3000;
/** How many of the stream's last segments that looks at. They start over with each ffmpeg run. */
const RECENT_SEGMENTS = 6;
/**
 * A segment that lasts longer than this may not be one the stream usually has: the first one after
 * the stream had no data for a while says it lasts all the time that is missing. It counts only
 * while it is no more than twice what the stream's last segments usually last (their median), as
 * the segments of a broadcast with key frames this far apart all are.
 */
const LONG_SEGMENT_SECONDS = 10;
/**
 * A playlist nobody asked for in this long goes on with its slate from now, instead of adding
 * every segment of it that came due meanwhile: nobody was there to play them.
 */
const CATCH_UP_MS = 60_000;
/**
 * For a player that has nothing to play, the slate starts this many of its segments ago, so it
 * gets three at once: a playlist it just opened, before the stream's first segment or with nothing
 * left to list. It then plays a few seconds behind the newest one, as it does on a stream that plays.
 * Nothing is counted for it (see `Count`): it is not behind, so it gets all the stream then delivers.
 */
const SLATE_SEGMENTS_AHEAD = 2;
/**
 * A change between the slate and the stream stays listed this long (see `VirtualPlaylist`). VLC
 * plays what it has before it goes on behind a discontinuity, and reads the playlist again only
 * then: a discontinuity that came and left the list meanwhile it never sees, and the video behind
 * it ends its playing. This covers a player that plays this far behind the newest segment.
 */
export const KEEP_CHANGES_MS = 20_000;
/**
 * When a segment of the stream came is known to within this: the pipeline looks for new ones once
 * a second, and whenever a player asks.
 */
const ARRIVAL_SLACK_MS = 1000;
/**
 * A segment in its own time is noticed no sooner after the one before it than it lasts, less that
 * second: the one before it was noticed a second late, and this one at once. Less this as well,
 * for a look that is itself a little early or late: the pipeline's timer is never on the dot.
 */
const LOOK_JITTER_MS = 250;
/** The count that starts with a slate (see `Count`) ends when the stream's segments were listed this long, one after the other. */
const SETTLED_MS = 30_000;
/**
 * While the slate shows, the stream's segments wait until none came for this long: the pipeline
 * looked once more, and found nothing new. A stream that makes up for a pause writes what it missed
 * within a moment, oldest first, over several looks. The newest of those are the ones to list (see
 * `firstListed`), and not only for what they show: ffmpeg deletes a segment's file when ten newer
 * ones are written, so the oldest of them are gone within seconds, while VLC asks for a listed
 * segment up to ten seconds later, and ends on a file that is gone.
 */
const HOLD_MS = ARRIVAL_SLACK_MS + LOOK_JITTER_MS;

/** What the stream's last segments usually last, in seconds: their median, the lower one of two. */
function usualOf(recent: readonly number[]): number {
  const sorted = recent.toSorted((one, other) => one - other);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

/**
 * How long after a segment of the stream the next one may take, from what the last segments of the
 * stream's ffmpeg run lasted (in seconds): a little longer than it usually takes to come. No
 * segment counts for more than `longest` seconds.
 */
function slateAfter(recent: readonly number[], longest: number): number {
  const usual = usualOf(recent);
  const counted = recent.filter(
    (seconds) => seconds <= LONG_SEGMENT_SECONDS || (seconds <= 2 * usual && seconds <= longest),
  );
  return Math.max(SLATE_AFTER_MS, Math.max(0, ...counted) * 1000 + SLATE_MARGIN_MS);
}

export interface ExternalPlaylistOptions {
  /** How many segments the playlist lists. */
  windowSize: number;
  /** Video older than this leaves the playlist, as it leaves the page's (see `PipelineSettings.liveEdge`). */
  staleAfterMs: number;
  /**
   * No segment of a stream that plays lasts longer than this: a full output that writes none for
   * this long is taken for stuck and started again (see `StuckLimits.fullOutputStallMs`).
   */
  longestSegmentMs: number;
  /** The slate, once it is made: none before that, or when it could not be made. */
  slate: () => Slate | undefined;
  /** The slate took the place of the stream's video. */
  onSlate?: () => void;
}

/** A segment of the stream, as it came. */
interface Arrival {
  generation: number;
  segment: PlaylistSegment;
  at: number;
}

/**
 * What the playlist listed since the slate last took over, against the time that passed.
 *
 * The slate stands in for video that does not come. When the stream then delivers that video
 * after all (an engine that was starved goes on where it stopped, and sends at once what it
 * missed), a playlist that lists both has grown by more than the time that passed, and every
 * player is that much further behind its newest segment from then on. That adds up with each
 * pause, until a player is so far behind that it loses its place (see `KEEP_CHANGES_MS`). So from
 * the stream's last segment before the slate, the playlist lists no more than the time that
 * passed: what the stream delivers on top of that is left out (see `firstListed`).
 *
 * There is no count after the slate for a player that had nothing (see `SLATE_SEGMENTS_AHEAD`).
 */
interface Count {
  /** From when it counts: when the stream's last segment before the slate came. */
  from: number;
  /** What the segments listed since then last, all together, in milliseconds. */
  listed: number;
  /** When the slate was last listed, or a segment of the stream left out. */
  brokenAt: number;
}

/**
 * A stream's playlist for players outside the page, such as VLC: the full output's segments, and
 * the slate while those don't come.
 *
 * The page's player waits when its playlist stops growing, and tries again when it fails. Other
 * players give up: the ones built on ffmpeg some ten seconds after the last new segment, and every
 * one of them at the first playlist request that fails. So this playlist always goes on. While
 * the stream starts, and whenever no segment of it came for a few seconds (`slateDue`), it lists
 * the slate's segments, one as each comes due, until the stream's video is listed again.
 *
 * The slate is a loop: its segments' timestamps run on from one to the next, as a player needs
 * (one segment listed over and over stops some players), and start over with each pass. Every
 * pass is therefore behind a discontinuity, like every change between the slate and the stream.
 *
 * The playlist is live: it never lists more than the time that passed. Video the stream delivers
 * late, for a time the slate already covered, is left out (see `Count`). The stream comes back from
 * the slate in one piece: its segments wait until it has delivered all it missed (see `HOLD_MS`).
 *
 * Nothing here runs by itself. The stream's segments come as its full output's playlist takes
 * them (`add`), and the slate's are added when a player asks for the playlist (`render`), up to
 * that moment. A playlist nobody asks for costs nothing.
 */
export class ExternalPlaylist {
  private readonly playlist: VirtualPlaylist;
  private readonly staleAfterMs: number;
  private readonly longestSegmentMs: number;
  private readonly slate: () => Slate | undefined;
  private readonly onSlate: (() => void) | undefined;
  /**
   * Counts the stretches the playlist is made of: a run of the stream's segments that follow one
   * another, or one pass of the slate. The playlist puts a discontinuity between two.
   */
  private stretch = 0;
  /** The ffmpeg run of the stream's last segment. */
  private lastGeneration: number | undefined;
  /** When the stream's last segment came, listed or not: never yet, before its first one. */
  private lastAt = -Infinity;
  /** While the slate shows: which of its segments is next... */
  private slateNext: number | undefined;
  /** ...and when that one is due, unless one of the stream is listed first. */
  private slateDueAt = 0;
  /** What the last segments of the stream's ffmpeg run lasted, in seconds. */
  private readonly recent: number[] = [];
  /** The stream's segments that are not looked at yet: the ones that came together, or that wait while the slate shows (see `add`). */
  private pending: Arrival[] = [];
  /** The count since the slate last took over, until the stream is back for good. */
  private count: Count | undefined;
  /** The stream's next segment doesn't follow the last one listed: it is of another ffmpeg run, or some were left out. */
  private apart = false;

  constructor(options: ExternalPlaylistOptions) {
    this.playlist = new VirtualPlaylist(options.windowSize, undefined, KEEP_CHANGES_MS);
    this.staleAfterMs = options.staleAfterMs;
    this.longestSegmentMs = options.longestSegmentMs;
    this.slate = options.slate;
    this.onSlate = options.onSlate;
  }

  /**
   * Takes a segment of the stream, as its full output's playlist took it. Segments that come
   * together are looked at together, so it is listed with the next ones that come or the next
   * time a player asks. While the slate shows it waits with the ones before it (see `HOLD_MS`),
   * until a player asks after that long, or until it is itself that much later than the last one.
   */
  readonly add: OnSegment = (generation, segment, at) => {
    const newest = this.pending.at(-1);
    const waits = newest?.generation === generation && this.holding;
    if (newest !== undefined && !waits && (newest.at !== at || newest.generation !== generation)) {
      this.take(at);
    }
    this.pending.push({ generation, segment, at });
    if (newest !== undefined && waits && at - newest.at >= HOLD_MS) {
      this.take(at);
    }
  };

  /**
   * The playlist as a player gets it at `now`, with the slate's segments that came due by then.
   * Undefined while it has nothing to list: no segment of the stream yet, or only old ones, and no slate.
   */
  render(now: number): string | undefined {
    this.playlist.expire(now - this.staleAfterMs);
    const newest = this.pending.at(-1);
    if (newest !== undefined && !(this.holding && now - newest.at < HOLD_MS)) {
      this.take(now);
    }
    this.addSlate(now);
    return this.playlist.render();
  }

  /** Whether the stream's segments wait: while the slate shows for a player that is counted for (see `Count`). */
  private get holding(): boolean {
    return this.slateNext !== undefined && this.count !== undefined;
  }

  /**
   * Lists the stream's segments that are not looked at yet, but for the ones that are left out.
   * The ones that waited while the slate showed are listed as of `now`, the others as of when they came.
   */
  private take(now: number): void {
    const batch = this.pending;
    const first = batch[0];
    const newest = batch.at(-1);
    if (first === undefined || newest === undefined) {
      return;
    }
    this.pending = [];
    const waited = this.holding;
    const at = waited ? now : first.at;
    const from = this.firstListed(batch, at, waited);
    if (first.generation !== this.lastGeneration) {
      // Another ffmpeg run may cut its segments differently: a re-encoded one every two seconds, a
      // copy at the broadcast's key frames.
      this.recent.length = 0;
      this.apart = true;
    }
    for (const [index, { segment }] of batch.entries()) {
      if (index < from) {
        this.leaveOut(at);
      } else {
        this.list(segment, at);
      }
      this.recent.push(segment.duration);
      if (this.recent.length > RECENT_SEGMENTS) {
        this.recent.shift();
      }
    }
    this.lastGeneration = first.generation;
    this.lastAt = newest.at;
  }

  /**
   * Which of the segments that are looked at together are listed: from this one on. All of them
   * while no slate was listed, as in the page's playlist. After a slate (see `Count`), the newest
   * ones that fit in the time that passed, since the older ones are video the slate stood in for.
   *
   * The ones that waited while the slate showed must fit with a second to spare
   * (`ARRIVAL_SLACK_MS`), so that the ones that follow in their own time fit as well, whenever they
   * are noticed. So must segments that came together later, or sooner than a segment in its own
   * time can be noticed (`LOOK_JITTER_MS`): those make up for a pause too. One that came alone and
   * no sooner than that has the benefit of that second instead: when a segment came is known to
   * within a second, and it may be the stream in its own time, noticed sooner than the one before
   * it was.
   *
   * One segment is listed although it doesn't fit, and the count starts anew with it: one that
   * came no later than the stream's segments usually do, while the slate shows. The slate was
   * early for this stream then, because players go by the short segments the playlist lists after
   * an outage (see `slateDue`), and a broadcast with key frames far apart would lose every segment
   * until one fits.
   */
  private firstListed(batch: readonly Arrival[], at: number, waited: boolean): number {
    const count = this.count;
    if (count === undefined) {
      return 0;
    }
    const newest = batch.at(-1);
    let room = at - count.from - count.listed + (waited ? -ARRIVAL_SLACK_MS : this.benefit(batch, at));
    let from = batch.length;
    while (from > 0) {
      const duration = (batch[from - 1]?.segment.duration ?? 0) * 1000;
      if (duration > room) {
        break;
      }
      room -= duration;
      from -= 1;
    }
    if (from === batch.length && newest !== undefined && this.onTime(newest)) {
      this.count = { from: newest.at, listed: -newest.segment.duration * 1000, brokenAt: count.brokenAt };
      return from - 1;
    }
    return from;
  }

  /** What segments that came together get on top of the time that passed (see `firstListed`), in milliseconds. */
  private benefit(batch: readonly Arrival[], at: number): number {
    const soonest = (batch[0]?.segment.duration ?? 0) * 1000 - ARRIVAL_SLACK_MS - LOOK_JITTER_MS;
    return batch.length > 1 || at - this.lastAt < soonest ? -ARRIVAL_SLACK_MS : ARRIVAL_SLACK_MS;
  }

  /**
   * Whether a segment that comes while the slate shows is no later than the stream's segments
   * usually are: within three seconds of what they usually last.
   */
  private onTime({ generation, at }: Arrival): boolean {
    return (
      this.slateNext !== undefined &&
      generation === this.lastGeneration &&
      at - this.lastAt <= usualOf(this.recent) * 1000 + SLATE_MARGIN_MS
    );
  }

  private leaveOut(at: number): void {
    this.apart = true;
    if (this.count !== undefined) {
      this.count.brokenAt = at;
    }
  }

  private list(segment: PlaylistSegment, at: number): void {
    if (this.slateNext !== undefined || this.apart) {
      this.stretch += 1;
    }
    this.playlist.append(this.stretch, [segment], "", at);
    this.slateNext = undefined;
    this.apart = false;
    const count = this.count;
    if (count === undefined) {
      return;
    }
    count.listed += segment.duration * 1000;
    if (at - count.brokenAt >= SETTLED_MS) {
      this.count = undefined;
    }
  }

  /**
   * When the slate takes the place of the stream's video: when the stream's next segment is late.
   *
   * That is by what the last segments of its ffmpeg run lasted (`slateAfter`), but never later than
   * a player waits. A player goes by the segments the playlist lists, so the slate comes no later
   * than three seconds more than the longest of those: after an outage they are the slate's, and
   * the stream's first segment may be the short end of a long one, so a player is back to waiting
   * ten seconds while the stream's next segment takes as long as its segments usually do. With
   * nothing left to list (the stream's last segments got old), that is five seconds, long gone.
   * Before the stream's first segment the slate is due at once.
   */
  private slateDue(): number {
    const listed = Math.max(SLATE_AFTER_MS, this.playlist.longest * 1000 + SLATE_MARGIN_MS);
    return this.lastAt + Math.min(slateAfter(this.recent, this.longestSegmentMs / 1000), listed);
  }

  /**
   * Adds the slate's segments that came due by `now`. After the stream's video they are due one
   * by one from the moment the stream's next segment was late, so the playlist stays behind the
   * time that passed by the seconds the slate waited, and the stream's next segment fits when it
   * comes. Only a player that has nothing gets three at once (see `SLATE_SEGMENTS_AHEAD`).
   */
  private addSlate(now: number): void {
    const segments = this.slate()?.segments ?? [];
    const starts = this.slateNext === undefined;
    const due = starts ? this.slateDue() : this.slateDueAt;
    const next = segments[this.slateNext ?? 0];
    if (due > now || next === undefined || !(next.duration > 0)) {
      return;
    }
    if (this.playlist.length === 0 || now - due > CATCH_UP_MS) {
      // Nothing is listed, or nobody asked for a long time: whoever asks now has nothing to play.
      this.slateDueAt = now - SLATE_SEGMENTS_AHEAD * next.duration * 1000;
      this.count = undefined;
    } else if (starts) {
      this.slateDueAt = due;
      this.count = { from: this.lastAt, listed: 0, brokenAt: now };
    }
    while (this.slateDueAt <= now) {
      const index = this.slateNext ?? 0;
      const segment = segments[index];
      if (segment === undefined || !(segment.duration > 0)) {
        return;
      }
      if (index === 0) {
        this.stretch += 1;
      }
      if (this.slateNext === undefined && this.lastGeneration !== undefined) {
        this.onSlate?.();
      }
      this.playlist.append(this.stretch, [segment], "", this.slateDueAt);
      this.slateNext = (index + 1) % segments.length;
      this.slateDueAt += segment.duration * 1000;
      if (this.count !== undefined) {
        this.count.listed += segment.duration * 1000;
        this.count.brokenAt = now;
      }
    }
  }
}
