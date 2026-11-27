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
 * The slate starts this many of its segments ago, so a player gets three at once. It has little
 * or nothing left to play by then: nothing of a playlist it just opened, and what it had of the
 * stream's video went while the slate waited. With three segments it plays a few seconds behind
 * the newest one again, as it does on a stream that plays. On one segment at a time it runs dry
 * at each, and VLC then waits longer before it plays what comes next, the stream's video included.
 */
const SLATE_SEGMENTS_AHEAD = 2;

/**
 * How long after a segment of the stream the next one may take, from what the last segments of the
 * stream's ffmpeg run lasted (in seconds): a little longer than it usually takes to come. No
 * segment counts for more than `longest` seconds.
 */
function slateAfter(recent: readonly number[], longest: number): number {
  const sorted = recent.toSorted((one, other) => one - other);
  const usual = sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
  const counted = sorted.filter(
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

/**
 * A stream's playlist for players outside the page, such as VLC: the full output's segments, and
 * the slate while those don't come.
 *
 * The page's player waits when its playlist stops growing, and tries again when it fails. Other
 * players give up: the ones built on ffmpeg some ten seconds after the last new segment, and every
 * one of them at the first playlist request that fails. So this playlist always goes on. While
 * the stream starts, and whenever no segment of it came for a few seconds (`slateDue`), it lists
 * the slate's segments, three to start with and one more as each comes due, until the stream's
 * next segment.
 *
 * The slate is a loop: its segments' timestamps run on from one to the next, as a player needs
 * (one segment listed over and over stops some players), and start over with each pass. Every
 * pass is therefore behind a discontinuity, like every change between the slate and the stream.
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
   * Counts the stretches the playlist is made of: a run of the stream's segments from one ffmpeg
   * run, or one pass of the slate. The playlist puts a discontinuity between two.
   */
  private stretch = 0;
  /** The ffmpeg run of the stream's last segment. */
  private lastGeneration: number | undefined;
  /** When the stream's last segment came: never yet, before its first one. */
  private lastAt = -Infinity;
  /** While the slate shows: which of its segments is next... */
  private slateNext: number | undefined;
  /** ...and when that one is due, unless one of the stream comes first. */
  private slateDueAt = 0;
  /** What the last segments of the stream's ffmpeg run lasted, in seconds. */
  private readonly recent: number[] = [];

  constructor(options: ExternalPlaylistOptions) {
    this.playlist = new VirtualPlaylist(options.windowSize);
    this.staleAfterMs = options.staleAfterMs;
    this.longestSegmentMs = options.longestSegmentMs;
    this.slate = options.slate;
    this.onSlate = options.onSlate;
  }

  /** Takes a segment of the stream, as its full output's playlist took it. */
  readonly add: OnSegment = (generation, segment, at) => {
    if (this.slateNext !== undefined || generation !== this.lastGeneration) {
      this.stretch += 1;
    }
    this.playlist.append(this.stretch, [segment], "", at);
    if (generation !== this.lastGeneration) {
      // Another ffmpeg run may cut its segments differently: a re-encoded one every two seconds, a
      // copy at the broadcast's key frames.
      this.recent.length = 0;
    }
    this.lastGeneration = generation;
    this.lastAt = at;
    this.slateNext = undefined;
    this.recent.push(segment.duration);
    if (this.recent.length > RECENT_SEGMENTS) {
      this.recent.shift();
    }
  };

  /**
   * The playlist as a player gets it at `now`, with the slate's segments that came due by then.
   * Undefined while it has nothing to list: no segment of the stream yet, or only old ones, and no slate.
   */
  render(now: number): string | undefined {
    this.playlist.expire(now - this.staleAfterMs);
    this.addSlate(now);
    return this.playlist.render();
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

  private addSlate(now: number): void {
    const segments = this.slate()?.segments ?? [];
    const starts = this.slateNext === undefined;
    if (starts && this.slateDue() > now) {
      return;
    }
    if (starts || now - this.slateDueAt > CATCH_UP_MS) {
      // It starts with the request that finds it due, and after a long time without one it goes on
      // from the request that comes: with three segments, for a player with nothing left to play.
      this.slateDueAt = now - SLATE_SEGMENTS_AHEAD * (segments[0]?.duration ?? 0) * 1000;
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
      // The segments it starts with are no older than what they follow.
      this.playlist.append(this.stretch, [segment], "", Math.max(this.slateDueAt, this.lastAt));
      this.slateNext = (index + 1) % segments.length;
      this.slateDueAt += segment.duration * 1000;
    }
  }
}
