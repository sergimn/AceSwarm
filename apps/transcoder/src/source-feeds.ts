import type { Logger } from "@aceswarm/shared/logger";
import { CutPointWatch, type CutPointTimes } from "./cut-point-watch.ts";
import type { FullMode } from "./ffmpeg-args.ts";
import { killProcess, type Connection, type Generation } from "./generation.ts";
import type { CutPoint } from "./h264-cut-points.ts";
import type { LayoutChange, LayoutMove, OpenSource, Sink, SourceEnd } from "./source-reader.ts";
import { changeKind, describeLayout, videoCodecOfLayout, type Layout, type LayoutChangeKind } from "./ts-tables.ts";

/** Browsers only decode H.264 reliably, so other codecs are re-encoded for the full output. */
const COPYABLE_CODECS = new Set(["h264"]);
/**
 * How long a run that handed over may take to write out its last segments before the next run's
 * are published without them. An ffmpeg whose input ended is done in well under a second.
 */
const DRAIN_TIMEOUT_MS = 3000;
/** How long ffmpeg may take to end by itself once its source did. */
const SOURCE_END_GRACE_MS = 5000;
/** How often a stream's changes that leave its run's streams in place are logged: tables can change every second. */
const IN_PLACE_LOG_MS = 60_000;
/** How many layouts a stream keeps ffmpeg's finding for (see `SourceFeeds.found`): far more than a broadcast goes through. */
const MAX_CORRECTED_LAYOUTS = 32;

/** What the full output does with video of this codec: browsers get H.264 as it is. */
export function fullModeFor(codec: string): FullMode {
  return COPYABLE_CODECS.has(codec) ? "copy" : "transcode";
}

/** How a run goes on from another one, on the same connection to their source. */
export interface Succession {
  /** What the stream carries from here on. */
  layout: Layout;
  mode: FullMode;
  /** The stream was already being read (see `FfmpegPlan.midStream`). */
  midStream: boolean;
  /** What the old run still writes out belongs to the stream: it is published before the new run's. */
  drain: boolean;
  /** How the broadcast changed its layout mid-stream, when that is why the run goes on from another. */
  change?: LayoutChangeKind;
}

/** What a stream's pipeline does for its feeds. */
export interface FeedHost {
  /**
   * Starts a run in place of `old` that goes on with its source from where the reader is. Returns
   * it, or undefined when `old` has no place in the pipeline any more.
   */
  succeed: (old: Generation, how: Succession, reason: string) => Generation | undefined;
  /** Adds the run's new segments to the stream's playlists. */
  publish: (run: Generation) => Promise<void>;
  retire: (run: Generation) => void;
  /**
   * The broadcast moved the run's streams to other PIDs mid-stream, and the run reads on (see
   * `PidMoves`): the stream showed a picture to go on from, so its video is there.
   */
  moved: (run: Generation) => void;
  /**
   * The broadcast's video has key frames ffmpeg can use again (see `SourceFeeds.onCutPoint`): the
   * stream's runs from now on may decode key frames only.
   */
  keyFramesBack: () => void;
}

/**
 * Feeds the ffmpeg runs of one stream from their sources (see `readSource`), and decides what each
 * run does with the video from what its source carries:
 *
 * - The full output's mode belongs to a run, not to the stream: it copies H.264 and re-encodes
 *   anything else, and everything once a copy of the stream's video couldn't be cut (see
 *   `copyFails`). A source's program tables say what it carries before ffmpeg gets a byte of it,
 *   so a run in the wrong mode is replaced right there, without reading the source again. A run
 *   starts in the mode that suited the stream's last known video, as most sources stay as they
 *   are. Where the tables don't tell (no MPEG-TS, or a kind of stream they don't name), ffmpeg's
 *   own finding decides, and where the two disagree, ffmpeg's finding wins for that layout from
 *   then on (see `found`): the mode never goes back and forth between what each of them says.
 *   A stream re-encoded because a copy couldn't be cut copies again once its broadcast sends key
 *   frames for a while (see `onCutPoint`).
 * - When the broadcast changes its layout mid-stream, a new run takes over at the change, on the
 *   same connection: no engine session is opened, and neither run misses a byte of its layout
 *   (players get the new one from its first key frame, where every ffmpeg run begins). The old
 *   run's input ends there; what it still writes out is published first (see `drain`).
 * - A change that only moves the same streams to other PIDs needs no new run: the reader passes
 *   them on under the PIDs the run's ffmpeg knows (see `PidMoves`), and the run reads on.
 */
export class SourceFeeds {
  /**
   * A run that copied the stream's video got no segment of it into the full output, right after
   * another that stalled (see `Stuck.reencode`): ffmpeg finds no key frame in that video to
   * start one at. The stream's runs re-encode it from then on, whatever the source says it
   * carries, until the broadcast sends key frames again (see `onCutPoint`).
   */
  get copyFails(): boolean {
    return this.reencoding;
  }

  set copyFails(fails: boolean) {
    if (fails && !this.reencoding) {
      // Key frames are counted from here on; after a copy that came back and failed again, for longer.
      this.counting = undefined;
      if (this.cameBackAt !== undefined) {
        this.cutPoints.failedAgain(this.now() - this.cameBackAt);
      }
    }
    this.reencoding = fails;
  }

  private reencoding = false;
  /** Tells when a copy can come back (see `onCutPoint`). */
  private readonly cutPoints: CutPointWatch;
  /**
   * The run whose cut points it counts: another source's time stamps go by another clock, and
   * after a change of layout or a move to other PIDs, the video may come from another encoder.
   */
  private counting: Generation | undefined;
  /** When a copy came back last, if one did (see `CutPointWatch.failedAgain`). */
  private cameBackAt: number | undefined;
  /** The codec of the video the stream's sources carried last, as far as known. */
  private codec: string | undefined;
  /** What ffmpeg found the video of a layout to be, where its tables say otherwise, or nothing. */
  private readonly corrected = new Map<string, string>();
  /** Runs that handed over mid-stream and may still write out their last segments, oldest first. */
  private readonly draining: Generation[] = [];
  /** When a change that left the run's streams in place was last logged (see `IN_PLACE_LOG_MS`). */
  private inPlaceLoggedAt = -Infinity;
  private readonly host: FeedHost;
  private readonly openSource: OpenSource;
  private readonly logger: Logger;
  private readonly now: () => number;

  /** `cutTimes`: what decides how far apart the cut points of a copy that comes back may be (see `CutPointWatch`). */
  constructor(host: FeedHost, openSource: OpenSource, logger: Logger, now: () => number, cutTimes: CutPointTimes) {
    this.cutPoints = new CutPointWatch(cutTimes);
    this.host = host;
    this.openSource = openSource;
    this.logger = logger;
    this.now = now;
  }

  /** The mode a run starts in, before its source said what it carries. */
  startMode(): FullMode {
    return this.modeFor(this.codec);
  }

  private modeFor(codec: string | undefined): FullMode {
    if (this.copyFails) {
      return "transcode";
    }
    return codec === undefined ? "copy" : fullModeFor(codec);
  }

  /**
   * ffmpeg found the codec of the video the run reads. Returns the full output's mode for it.
   * ffmpeg is the one that decodes the stream, so where the layout's tables name another codec
   * (or none), its finding stands for that layout from then on: a run that starts on it later is
   * not replaced for what the tables say, which ffmpeg would only correct again.
   */
  found(run: Generation, codec: string): FullMode {
    const { layout } = run;
    // Its newest finding counts: one that agrees with the tables takes an older one back.
    this.corrected.delete(layout?.key ?? "");
    if (layout !== undefined && videoCodecOfLayout(layout) !== codec) {
      this.correct(layout.key, codec);
    }
    return this.carries(codec);
  }

  private correct(key: string, codec: string): void {
    this.corrected.set(key, codec);
    if (this.corrected.size > MAX_CORRECTED_LAYOUTS) {
      this.corrected.delete(this.corrected.keys().next().value ?? "");
    }
  }

  /** Notes the codec of the video a source carries now. Returns the full output's mode for it. */
  private carries(codec: string): FullMode {
    this.codec = codec;
    return this.modeFor(codec);
  }

  /** Starts reading the run's source into its ffmpeg. */
  open(run: Generation): void {
    const connection: Connection = { run, reader: undefined };
    run.connection = connection;
    connection.reader = this.openSource({
      source: run.source,
      idleTimeoutMs: run.inputTimeoutSeconds * 1000,
      sink: run.sink,
      onLayout: (change) => this.onLayout(connection, change),
      onMove: (move) => {
        this.onMove(connection, move);
      },
      cutPoints: {
        watching: () => this.watchesCuts(connection.run),
        found: (pts, point) => this.onCutPoint(connection, pts, point),
      },
      onEnd: (end) => {
        this.onEnd(connection, end);
      },
    });
  }

  private onLayout(connection: Connection, change: LayoutChange): Sink | undefined {
    const run = connection.run;
    if (run.retired) {
      return undefined;
    }
    const { layout, previous } = change;
    const codec = this.corrected.get(layout.key) ?? videoCodecOfLayout(layout);
    // Tables that don't name the video's codec leave the mode as it is: ffmpeg's finding decides.
    const mode = codec === undefined ? run.mode : this.carries(codec);
    if (previous === undefined) {
      run.layout = layout;
      if (mode === run.mode) {
        return undefined;
      }
      this.logger.info({ generation: run.number, codec, mode }, "the source's video needs another mode");
      // The run was started for other video: whatever it made of this stream so far is not kept.
      return this.host.succeed(run, { layout, mode, midStream: change.delivered, drain: false }, mode)?.sink;
    }
    const kind = changeKind(previous, layout);
    // `unfit`: why the run could not read on, where the reader looked into that (see `PidMoves`).
    const { unfit } = change;
    this.logger.info(
      { generation: run.number, kind, from: describeLayout(previous), to: describeLayout(layout), mode, unfit },
      "the broadcast changed its layout; a new ffmpeg run takes over",
    );
    const how: Succession = { layout, mode, midStream: true, drain: change.delivered, change: kind };
    return this.host.succeed(run, how, "layout")?.sink;
  }

  /**
   * The broadcast moved its streams to other PIDs, and the reader passes them on under the ones
   * the run's ffmpeg knows, or it left the streams ffmpeg reads where they were: the run reads on
   * as it is. They are the same streams, so the mode stays, and so does what ffmpeg found their
   * video to be.
   */
  private onMove(connection: Connection, move: LayoutMove): void {
    const run = connection.run;
    if (run.retired) {
      return;
    }
    const { layout, previous, inPlace } = move;
    run.layout = layout;
    const found = this.corrected.get(previous.key);
    if (found !== undefined) {
      this.correct(layout.key, found);
    }
    const details = { generation: run.number, from: describeLayout(previous), to: describeLayout(layout) };
    if (!inPlace) {
      if (this.counting === run) {
        this.counting = undefined;
      }
      this.logger.info(details, "the broadcast moved its streams to other PIDs; the same ffmpeg run reads on");
      this.host.moved(run);
      return;
    }
    // Tables can go back and forth for as long as the broadcast lasts: one line a minute tells of it.
    const quiet = this.now() - this.inPlaceLoggedAt < IN_PLACE_LOG_MS;
    this.inPlaceLoggedAt = quiet ? this.inPlaceLoggedAt : this.now();
    this.logger[quiet ? "debug" : "info"](
      details,
      "the broadcast changed its tables, and the streams ffmpeg reads are where they were; the same ffmpeg run reads on",
    );
  }

  /**
   * Whether the run re-encodes video that a copy of could come back for: H.264, as far as known. A
   * run that began to copy before a copy failed (one that is to take over, say) copies already.
   */
  private watchesCuts(run: Generation): boolean {
    const { layout } = run;
    const codec = layout === undefined ? undefined : (this.corrected.get(layout.key) ?? videoCodecOfLayout(layout));
    return this.copyFails && !run.retired && run.mode === "transcode" && fullModeFor(codec ?? "") === "copy";
  }

  /**
   * An access unit came that ffmpeg can cut a copy of the video at, while the stream is re-encoded
   * because a copy couldn't be cut (see `copyFails`). Once they came often enough for a while (see
   * `CutPointWatch`), the broadcast has key frames again: a run that copies the video takes over
   * right at this unit, on the same connection, as at a change of layout, and the stream's later
   * runs copy it too. One that then can't be cut again is found out as before (see `StuckRuns`).
   * Key frames only decoding comes back where every cut point that counted was an IDR picture: of
   * recovery points, ffmpeg 9's decoder shows next to nothing that way (an intra refresh never
   * ends, and an open GOP with B-frames gets stuck in the decoder's reordering).
   */
  private onCutPoint(
    connection: Connection,
    pts: number | undefined,
    point: Exclude<CutPoint, "none">,
  ): Sink | undefined {
    const run = connection.run;
    const { layout } = run;
    if (!this.watchesCuts(run) || layout === undefined) {
      return undefined;
    }
    if (this.counting !== run) {
      this.counting = run;
      this.cutPoints.reset();
    }
    if (!this.cutPoints.cutPoint(pts, point)) {
      return undefined;
    }
    const { onlyIdrs } = this.cutPoints;
    this.logger.info(
      { generation: run.number, seconds: this.cutPoints.waitMs / 1000, at: point, onlyIdrs },
      "the broadcast's video has key frames again; copying the full stream again",
    );
    this.reencoding = false;
    this.cameBackAt = this.now();
    this.cutPoints.reset();
    if (onlyIdrs) {
      this.host.keyFramesBack();
    }
    return this.host.succeed(run, { layout, mode: "copy", midStream: true, drain: true }, "key-frames")?.sink;
  }

  /** The reader is done with the source: its run's ffmpeg writes out what it has, and ends. */
  private onEnd(connection: Connection, end: SourceEnd): void {
    const run = connection.run;
    if (run.retired) {
      return;
    }
    run.error ??= end.reason;
    this.logger.info({ generation: run.number, reason: end.reason }, "the source ended");
    run.sink.end();
    const timer = setTimeout(() => {
      killProcess(run.process);
    }, SOURCE_END_GRACE_MS);
    timer.unref();
  }

  /**
   * The run handed over mid-stream (see `Succession.drain`): its ffmpeg's input ends where the
   * next run's begins, and it writes out the frames it still has.
   */
  drainLater(run: Generation): void {
    run.handedOverAt = this.now();
    this.draining.push(run);
  }

  /**
   * Publishes what the runs that handed over still wrote, oldest first, and retires those that are
   * done. Returns whether one is still at it: until then nothing newer is published, as a
   * playlist only ever goes forward.
   */
  async drain(): Promise<boolean> {
    for (;;) {
      const run = this.draining[0];
      if (run === undefined) {
        return false;
      }
      const done = run.state === "exited" || this.now() - (run.handedOverAt ?? 0) >= DRAIN_TIMEOUT_MS;
      await this.host.publish(run);
      // The frames it still wrote out are the stream's newest, until the run after it has its own.
      const { successor, publishedFrameAt } = run;
      if (successor !== undefined && publishedFrameAt !== undefined) {
        successor.publishedFrameAt = Math.max(successor.publishedFrameAt ?? 0, publishedFrameAt);
      }
      if (!done) {
        return true;
      }
      // Another sync may have dealt with it meanwhile.
      if (this.draining[0] === run) {
        this.draining.shift();
        this.host.retire(run);
      }
    }
  }

  /** Whether the run still drains: the pipeline keeps publishing its segments. */
  drains(run: Generation): boolean {
    return this.draining.includes(run);
  }

  /** Kills the runs that still drain, as the stream stops: what they would write out is not kept. */
  stop(): void {
    for (const run of this.draining.splice(0)) {
      run.stopNow();
    }
  }
}
