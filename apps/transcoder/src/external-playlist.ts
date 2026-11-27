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
/** How many of the stream's last segments that looks at. */
const RECENT_SEGMENTS = 6;
/**
 * A segment that says it lasts longer than this doesn't count there: it is the first one after the
 * stream had no data for a while, whose timestamps span the time that is missing.
 */
const LONGEST_SEGMENT_SECONDS = 10;
/**
 * A playlist nobody asked for in this long starts its slate over from now, instead of adding every
 * segment of it that came due meanwhile: nobody was there to play them.
 */
const CATCH_UP_MS = 60_000;

export interface ExternalPlaylistOptions {
  /** How many segments the playlist lists. */
  windowSize: number;
  /** Video older than this leaves the playlist, as it leaves the page's (see `PipelineSettings.liveEdge`). */
  staleAfterMs: number;
  /** The slate, once it is made: none before that, or when it could not be made. */
  slate: () => Slate | undefined;
  /** When the playlist starts: the slate is due from then on, until the stream's first segment. */
  now: number;
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
 * the stream starts, and whenever no segment of it came for a few seconds (`SLATE_AFTER_MS`), it
 * lists the slate's segments, one more as each comes due, until the stream's next segment.
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
  private readonly slate: () => Slate | undefined;
  private readonly onSlate: (() => void) | undefined;
  /**
   * Counts the stretches the playlist is made of: a run of the stream's segments from one ffmpeg
   * run, or one pass of the slate. The playlist puts a discontinuity between two.
   */
  private stretch = 0;
  /** The ffmpeg run of the stream's last segment. */
  private lastGeneration: number | undefined;
  /** While the slate shows: which of its segments is next. */
  private slateNext: number | undefined;
  /** When the next segment of the slate is due, unless one of the stream comes first. */
  private slateDueAt: number;
  /** What the stream's last segments lasted, in seconds. */
  private readonly recent: number[] = [];

  constructor(options: ExternalPlaylistOptions) {
    this.playlist = new VirtualPlaylist(options.windowSize);
    this.staleAfterMs = options.staleAfterMs;
    this.slate = options.slate;
    this.onSlate = options.onSlate;
    this.slateDueAt = options.now;
  }

  /** Whether the playlist's newest segment is the slate's. */
  get showsSlate(): boolean {
    return this.slateNext !== undefined;
  }

  /** Takes a segment of the stream, as its full output's playlist took it. */
  readonly add: OnSegment = (generation, segment, at) => {
    if (this.slateNext !== undefined || generation !== this.lastGeneration) {
      this.stretch += 1;
    }
    this.playlist.append(this.stretch, [segment], "", at);
    this.lastGeneration = generation;
    this.slateNext = undefined;
    if (segment.duration <= LONGEST_SEGMENT_SECONDS) {
      this.recent.push(segment.duration);
    }
    if (this.recent.length > RECENT_SEGMENTS) {
      this.recent.shift();
    }
    this.slateDueAt = at + Math.max(SLATE_AFTER_MS, Math.max(0, ...this.recent) * 1000 + SLATE_MARGIN_MS);
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

  private addSlate(now: number): void {
    const segments = this.slate()?.segments ?? [];
    if (now - this.slateDueAt > CATCH_UP_MS) {
      this.slateDueAt = now;
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
    }
  }
}
