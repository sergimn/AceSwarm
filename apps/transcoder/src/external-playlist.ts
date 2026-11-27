import { HLS_DELETE_THRESHOLD } from "./ffmpeg-args.ts";
import { segmentIndex, VirtualPlaylist, type OnSegment, type PlaylistSegment } from "./playlist.ts";

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
 * A segment that lasts longer than this may not be one the stream usually has: one with a jump in
 * its timestamps, where the stream had no data for a while, lasts the time that is missing as well.
 * (ffmpeg 9.0.2 writes one where it copies the video and less than ten seconds of data were lost:
 * ten seconds for seven lost. Where it encodes the video it writes that time as segments at once,
 * and where more were lost it moves the timestamps back.) It counts only while it is no more than
 * twice what the stream's last segments usually last (their median), as the segments of a
 * broadcast with key frames this far apart all are.
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
 * A discontinuity stays listed this long (see `VirtualPlaylist`): a change between the slate and
 * the stream, a pass of the slate's loop, another ffmpeg run, or segments left out. VLC plays what
 * it has before it goes on behind a discontinuity, and reads the playlist again only then: a
 * discontinuity that came and left the list meanwhile it never sees, and the video behind it ends
 * its playing. This covers a player that plays this far behind the newest segment. But no longer
 * than the files of the segments listed are there (see `gone`): a run that writes faster than in
 * real time deletes them sooner.
 */
export const KEEP_CHANGES_MS = 20_000;
/**
 * When a segment of the stream came is known to within this: the pipeline looks for new ones once
 * a second, and whenever a player asks.
 */
const ARRIVAL_SLACK_MS = 1000;
/** A look is itself a little early or late: the pipeline's timer is never on the dot. */
const LOOK_JITTER_MS = 250;
/**
 * ffmpeg writes a segment when the data that ends it comes, and a source sends its data in
 * pieces: a segment of the stream in its own time is written up to this much after its time
 * (measured: 0.7 seconds, with the source's data in pieces of 256 KiB).
 */
const WRITE_JITTER_MS = 750;
/**
 * How far off the stream's own time its segments can be noticed, all told. What the stream
 * makes up for leaves this much of the time that passed unlisted (see `firstListed`), so that
 * the segments that follow in their own time fit whenever they are noticed. And a stream whose
 * video came within this of the time that passed is in its own time (see `waitIsOver`).
 */
const NOTICE_SLACK_MS = ARRIVAL_SLACK_MS + LOOK_JITTER_MS + WRITE_JITTER_MS;
/**
 * While the slate shows, the stream's segments wait until it made up for all it missed, or until
 * it came in its own time for this long (see `waitIsOver`): a stream that comes back behind and
 * stays behind never makes up. That is what it takes to tell it from one that makes up at one
 * and a half times real time, when segments are noticed `NOTICE_SLACK_MS` off their time. A
 * stream that makes up that fast deletes its files that much sooner (see `gone`), and listed
 * while it does, its segments come behind a discontinuity every so often: VLC asks for the second
 * segment behind one only once it played what it had, some ten seconds later, and ends on a file
 * that is gone.
 */
const PACE_SPAN_MS = 10_000;
/**
 * Of the stream's segments that waited while the slate showed, no more than this many are listed,
 * the newest: VLC asks for the second segment behind a discontinuity some ten seconds after the
 * first, and ffmpeg deletes a segment's file when ten newer ones are written, sooner while the
 * stream still makes up for its pause.
 */
const WAITED_LISTED_AT_MOST = 3;
/** How many of the looks that found the stream's segments a count remembers (see `Count.looks`): more than `PACE_SPAN_MS` takes. */
const LOOKS_REMEMBERED = 64;
/** How many ffmpeg runs' newest segments the playlist remembers (see `gone`): far more than are listed at once. */
const RUNS_REMEMBERED = 8;
/**
 * The count that starts with a slate (see `Count`) ends when the stream's segments were listed this
 * long, with neither the slate nor a segment left out between them, once it left out about as much
 * of the stream's video as the slate stood in for: from then on the playlist is never more than
 * `NOTICE_SLACK_MS` ahead of the time that passed (see `Count.owed`), whatever the stream delivers.
 * One that makes up for its pause slowly delivers more than the time that passed for minutes, and
 * may pause again meanwhile. One that never makes up for it (it came back late and stays so) is
 * counted on, through the slates that follow too, which costs it next to nothing: in its own time
 * it fits (see the notes' limits).
 */
const SETTLED_MS = 30_000;

/**
 * The clock to give the playlist its times by, in milliseconds: one that never goes back. The
 * playlist counts what it lists against the time that passed (see `Count`), and a wall clock that is
 * set back would leave out the stream's every new segment for as long as it went back.
 */
export function steadyNow(): number {
  return performance.timeOrigin + performance.now();
}

/** The folder of a segment's file, as the playlist names it: each ffmpeg run writes its segments to its own. */
function folderOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf("/") + 1);
}

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

/** A look that found segments of the stream: when it was, and how much of its video had come up to then, in milliseconds. */
interface Look {
  at: number;
  came: number;
}

/**
 * What the playlist listed since the slate last took over, against the time that passed.
 *
 * The slate stands in for video that does not come. When the stream then delivers that video
 * after all (an engine that was starved goes on where it stopped, and sends what it missed at
 * once or faster than in real time), a playlist that lists both has grown by more than the time
 * that passed, and every player is that much further behind its newest segment from then on.
 * That adds up with each pause, until a player is so far behind that it loses its place (see
 * `KEEP_CHANGES_MS`). So from the stream's last segment before the slate, the playlist lists no
 * more than the time that passed: what the stream delivers on top of that is left out (see
 * `firstListed`).
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
  /**
   * How much of the stream's video came since `from`, listed or not, in milliseconds: the stream
   * made up for what it missed when that is about the time that passed since `since` (see
   * `waitIsOver`). Where ffmpeg wrote more segments between two looks than its playlist lists, the
   * ones the pipeline never saw came too: each counts for as long as the stream's segments usually last...
   */
  came: number;
  /**
   * ...and `since` is `from`, or later where video is missing for good: before the first segment
   * of another ffmpeg run.
   */
  since: number;
  /** The last looks that found segments of the stream, oldest first. */
  looks: Look[];
  /**
   * How much more the playlist listed since the count started than the stream's video that came,
   * in milliseconds: the slate's time, less the stream's video it left out (or never saw), and to
   * start with, as much as the stream was behind then where it was still making up for an earlier
   * pause (see `addSlate`). A stream never gets ahead of the time that passed, so it can make up
   * for no more than this: where this is about nothing, nothing it delivers puts the playlist
   * further ahead of the time that passed since `from` than the count lets it be.
   */
  owed: number;
  /** Whether a segment was listed since the stream is back although it didn't fit (see `firstListed`). */
  overdrawn: boolean;
}

/** From which of `batch` on its newest segments fit in `room` milliseconds. */
function fitting(batch: readonly Arrival[], room: number): number {
  let left = room;
  let from = batch.length;
  while (from > 0) {
    const duration = (batch[from - 1]?.segment.duration ?? 0) * 1000;
    if (duration > left) {
      break;
    }
    left -= duration;
    from -= 1;
  }
  return from;
}

/**
 * Whether the stream came in its own time over the last `PACE_SPAN_MS` of `looks` at least: no
 * more video than the time that passed, and no pause in between, where a look came later after the
 * one before it than the video it found lasts, give or take how far off their time segments are
 * noticed.
 */
function paced(looks: readonly Look[]): boolean {
  const newest = looks.at(-1);
  for (let index = looks.length - 1; newest !== undefined && index > 0; index -= 1) {
    const look = looks[index];
    const before = looks[index - 1];
    if (look === undefined || before === undefined || look.at - before.at > look.came - before.came + NOTICE_SLACK_MS) {
      return false;
    }
    if (newest.at - before.at >= PACE_SPAN_MS) {
      return newest.came - before.came <= newest.at - before.at + NOTICE_SLACK_MS;
    }
  }
  return false;
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
 * the slate in one piece: its segments wait until it made up for what it missed, or came in its own
 * time for a while (see `waitIsOver`).
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
  /** The ffmpeg run of the stream's last segment that was looked at... */
  private lastGeneration: number | undefined;
  /** ...and its number in that run. */
  private lastIndex = -1;
  /** When the stream's last segment that was looked at came, listed or not: never yet, before its first one. */
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
  /** The stream's next segment doesn't follow the last one listed: it is of another ffmpeg run, or some were left out or never came. */
  private apart = false;
  /** How many of a run's newest segment files ffmpeg keeps: as many as its playlist lists, and a few more. */
  private readonly filesKept: number;
  /** The number of each ffmpeg run's newest segment, by the folder of its files (see `gone`). */
  private readonly newestFiles = new Map<string, number>();

  constructor(options: ExternalPlaylistOptions) {
    this.playlist = new VirtualPlaylist(options.windowSize, undefined, KEEP_CHANGES_MS);
    // ffmpeg's playlist lists as many as this one does.
    this.filesKept = options.windowSize + HLS_DELETE_THRESHOLD;
    this.staleAfterMs = options.staleAfterMs;
    this.longestSegmentMs = options.longestSegmentMs;
    this.slate = options.slate;
    this.onSlate = options.onSlate;
  }

  /**
   * Takes a segment of the stream, as its full output's playlist took it, at `at`: all that one
   * look of the pipeline found comes at the same time. Segments that come together are looked at
   * together, so it is listed with the next ones that come or the next time a player asks. While
   * the slate shows it waits with the ones before it, until the wait is over (`waitIsOver`).
   */
  readonly add: OnSegment = (generation, segment, at) => {
    const folder = folderOf(segment.uri);
    this.newestFiles.delete(folder);
    this.newestFiles.set(folder, segmentIndex(segment.uri));
    if (this.newestFiles.size > RUNS_REMEMBERED) {
      this.newestFiles.delete(this.newestFiles.keys().next().value ?? folder);
    }
    const newest = this.pending.at(-1);
    const looked = newest !== undefined && (newest.at !== at || newest.generation !== generation);
    if (looked && (!this.holding || newest.generation !== generation || this.waitIsOver())) {
      this.take(at);
    }
    this.counts({ generation, segment, at });
    this.pending.push({ generation, segment, at });
    const oldest = this.pending[0];
    if (!this.holding || this.pending.length <= this.filesKept || oldest === undefined) {
      return;
    }
    // Of the ones that wait, only the newest are listed (see `firstListed`): ffmpeg deleted the
    // files of the others, and a stream that never ends the wait would pile them up.
    this.pending.shift();
    this.leaveOut(oldest.segment, at);
  };

  /**
   * The playlist as a player gets it at `now`, with the slate's segments that came due by then.
   * Undefined while it has nothing to list: no segment of the stream yet, or only old ones, and no slate.
   */
  render(now: number): string | undefined {
    this.playlist.expire(now - this.staleAfterMs);
    if (this.pending.length > 0 && (!this.holding || this.waitIsOver())) {
      this.take(now);
    }
    this.playlist.dropGone(this.gone);
    this.addSlate(now);
    return this.playlist.render();
  }

  /**
   * Whether the file of a segment the playlist lists is gone: ffmpeg deleted it, since its run wrote
   * as many newer ones as it keeps (measured: when it writes the tenth newer one, with a playlist of
   * six). That is so of a segment the playlist kept listed behind a change (see
   * `KEEP_CHANGES_MS`), or one before others it left out (see `Count`). The slate's files are never gone.
   */
  private readonly gone = (uri: string): boolean => {
    const newest = this.newestFiles.get(folderOf(uri));
    return newest !== undefined && segmentIndex(uri) <= newest - this.filesKept;
  };

  /** Whether the stream's segments wait: while the slate shows for a player that is counted for (see `Count`). */
  private get holding(): boolean {
    return this.slateNext !== undefined && this.count !== undefined;
  }

  /** Counts a segment of the stream that came (see `Count.came`). */
  private counts({ generation, segment, at }: Arrival): void {
    const count = this.count;
    if (count === undefined) {
      return;
    }
    const before = this.pending.at(-1);
    count.came += segment.duration * 1000;
    if (generation === (before?.generation ?? this.lastGeneration)) {
      // ffmpeg may have written more than its playlist lists since the last look: while the stream
      // makes up for a pause at once. The ones between came, though the pipeline never saw them.
      const after = before === undefined ? this.lastIndex : segmentIndex(before.segment.uri);
      const unseen = Math.max(0, segmentIndex(segment.uri) - after - 1) * (usualOf(this.recent) || segment.duration);
      count.came += unseen * 1000;
      count.owed -= unseen * 1000;
    } else {
      // Another ffmpeg run: the video before its first segment is missing for good, and the stream
      // goes on from here, in its own time.
      count.since = at - count.came;
    }
    const look = count.looks.at(-1);
    if (look?.at === at) {
      look.came = count.came;
      return;
    }
    count.looks.push({ at, came: count.came });
    if (count.looks.length > LOOKS_REMEMBERED) {
      count.looks.shift();
    }
  }

  /**
   * Whether the stream's segments that wait while the slate shows are taken now, as of the last
   * look that found some. The stream made up for all it missed: as much of its video came as time
   * passed since its last segment before the slate, less how far off their time segments are
   * noticed or one of its segments, whichever is more (the one it is writing is not there yet). Or
   * it came in its own time for a while (`PACE_SPAN_MS`), however far behind it is.
   *
   * A stream that makes up for a pause writes what it missed oldest first: at once, over several
   * looks, or at a pace somewhat faster than real time for a while. The newest of those are the ones
   * to list (see `firstListed`), and not only for what they show: ffmpeg deletes a segment's file
   * when ten newer ones are written, so the oldest of them are gone soon, while VLC asks for a
   * listed segment up to ten seconds later, and ends on a file that is gone.
   */
  private waitIsOver(): boolean {
    const count = this.count;
    const look = count?.looks.at(-1);
    if (count === undefined || look === undefined) {
      return true;
    }
    const usual = usualOf(this.recent) * 1000;
    return look.came >= look.at - count.since - Math.max(NOTICE_SLACK_MS, usual) || paced(count.looks);
  }

  /**
   * Lists the stream's segments that are not looked at yet, but for the ones that are left out,
   * and the ones older than the stale threshold: their video is old. The ones that waited while the
   * slate showed are listed as of `now`, the others as of when they came. With `listing` false,
   * all of them are left out.
   */
  private take(now: number, listing = true): void {
    const batch = this.pending;
    const first = batch[0];
    const newest = batch.at(-1);
    if (first === undefined || newest === undefined) {
      return;
    }
    this.pending = [];
    const waited = this.holding;
    const at = waited ? now : first.at;
    const from = listing ? this.firstListed(batch, waited) : batch.length;
    if (first.generation !== this.lastGeneration) {
      // Another ffmpeg run may cut its segments differently: a re-encoded one every two seconds, a
      // copy at the broadcast's key frames.
      this.recent.length = 0;
      this.apart = true;
    }
    for (const [index, arrival] of batch.entries()) {
      const number = segmentIndex(arrival.segment.uri);
      if (number !== this.lastIndex + 1) {
        // ffmpeg wrote more than its playlist lists between two looks: the ones between never came.
        this.apart = true;
      }
      this.lastIndex = number;
      if (index < from || arrival.at < now - this.staleAfterMs) {
        this.leaveOut(arrival.segment, at);
      } else {
        this.list(arrival.segment, at);
      }
      this.recent.push(arrival.segment.duration);
      if (this.recent.length > RECENT_SEGMENTS) {
        this.recent.shift();
      }
    }
    this.lastGeneration = first.generation;
    // So too where all of them were left out: where none of the ones that waited fit, the slate
    // gives way to the stream's next one that is on time after the newest of them (see `onTime`).
    this.lastAt = newest.at;
  }

  /**
   * Which of the segments that are looked at together are listed: from this one on. All of them
   * while no slate was listed, as in the page's playlist. After a slate (see `Count`), the newest
   * ones that fit in the time that passed until the newest came, since the older ones are video the
   * slate stood in for.
   *
   * Where some don't fit, the ones listed must fit with `NOTICE_SLACK_MS` to spare, and so must the
   * ones that waited while the slate showed: they make up for a pause, and the stream's segments
   * that follow in their own time fit then, however far off their time they are noticed. Of the
   * ones that waited, no more than `WAITED_LISTED_AT_MOST` are listed.
   *
   * One segment is listed although it doesn't fit, and the count starts anew with it, with
   * `NOTICE_SLACK_MS` to spare: one that came no later than the stream's segments usually do, while
   * the slate shows. The slate was early for this stream then, because players go by the short
   * segments the playlist lists after an outage (see `slateDue`), and a broadcast with key frames
   * far apart would lose every segment until one fits. So too where none of the ones that waited
   * fit with `NOTICE_SLACK_MS` to spare, as for a stream that came back in its own time at some
   * moments between the slate's segments: they are left out, and the stream's next segment comes
   * on time after the newest of them, and ends the slate. And once a count, a segment that came alone
   * while the stream shows may miss the time that passed by up to `NOTICE_SLACK_MS` (`overdrawn`),
   * and the count starts anew with it in the same way: what the stream made up for may have used up
   * all there was to spare, and its next segment in its own time, noticed late, would be left out.
   *
   * A pause too short for the slate needs nothing of its own: what the stream delivers for it is no
   * more than the time that passed, and fits.
   */
  private firstListed(batch: readonly Arrival[], waited: boolean): number {
    const count = this.count;
    const newest = batch.at(-1);
    if (count === undefined || newest === undefined) {
      return 0;
    }
    const room = newest.at - count.from - count.listed;
    let from = fitting(batch, room);
    if (waited || from > 0) {
      from = fitting(batch, room - NOTICE_SLACK_MS);
    }
    if (waited) {
      from = Math.max(from, batch.length - WAITED_LISTED_AT_MOST);
    }
    if (from === batch.length && this.onTime(newest)) {
      this.count = { ...count, from: newest.at, listed: -newest.segment.duration * 1000 - NOTICE_SLACK_MS };
      return from - 1;
    }
    const short = newest.segment.duration * 1000 - room;
    if (!waited && batch.length === 1 && from === 1 && !count.overdrawn && short <= NOTICE_SLACK_MS) {
      this.count = {
        ...count,
        from: newest.at,
        listed: -newest.segment.duration * 1000 - NOTICE_SLACK_MS,
        overdrawn: true,
      };
      return 0;
    }
    return from;
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

  private leaveOut(segment: PlaylistSegment, at: number): void {
    this.apart = true;
    const count = this.count;
    if (count === undefined) {
      return;
    }
    count.brokenAt = at;
    count.owed -= segment.duration * 1000;
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
    if (at - count.brokenAt >= SETTLED_MS && count.owed <= NOTICE_SLACK_MS) {
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
   * ten seconds while the stream's next segment takes as long as its segments usually do. Before
   * the stream's first segment the slate is due at once, and so it is with nothing left to list (see
   * `addSlate`).
   */
  private slateDue(): number {
    const listed = Math.max(SLATE_AFTER_MS, this.playlist.longest * 1000 + SLATE_MARGIN_MS);
    return this.lastAt + Math.min(slateAfter(this.recent, this.longestSegmentMs / 1000), listed);
  }

  /** When the slate's next segment is due, as of `now`. */
  private nextSlateDue(now: number): number {
    if (this.slateNext !== undefined) {
      return this.slateDueAt;
    }
    // A playlist without segments ends a player. It has none when the stream's last ones got old,
    // which they can before the next one is late with a short stale threshold, or when ffmpeg
    // deleted their files (see `gone`): the stream's last segment may have come a moment ago then,
    // and been left out (see `Count`).
    return this.playlist.length === 0 ? now : this.slateDue();
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
    const due = this.nextSlateDue(now);
    const next = segments[this.slateNext ?? 0];
    if (due > now || next === undefined || !(next.duration > 0)) {
      return;
    }
    if (this.playlist.length === 0 || now - due > CATCH_UP_MS) {
      // Nothing is listed, or nobody asked for a long time: whoever asks now has nothing to play,
      // and gets the stream's segments that come after the slate's. The ones that wait are old by
      // then, and the oldest of them about to go (see `gone`): they are left out.
      this.take(now, false);
      this.slateDueAt = now - SLATE_SEGMENTS_AHEAD * next.duration * 1000;
      this.count = undefined;
    } else if (starts) {
      this.slateDueAt = due;
      // A count that still runs hands on as much as the stream is behind then (see `Count.owed`):
      // one that makes up for a pause slowly may pause again before it has, and then delivers what
      // it missed of both pauses after this one. Where it is ahead, as another ffmpeg run's first
      // segments that come together make it, it hands on nothing: less would end the next count
      // before the stream made up for this pause.
      const behind = this.count === undefined ? 0 : this.lastAt - this.count.since - this.count.came;
      this.count = {
        from: this.lastAt,
        listed: 0,
        brokenAt: now,
        came: 0,
        since: this.lastAt,
        looks: [],
        overdrawn: false,
        owed: Math.max(0, behind),
      };
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
        this.count.owed += segment.duration * 1000;
      }
    }
  }
}
