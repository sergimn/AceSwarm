import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { PipelineState, PipelineStatus } from "@aceswarm/shared/api-types";
import type { FullMode } from "./ffmpeg-args.ts";
import type { LiveEdge } from "./live-edge.ts";
import { NO_SINK, type Sink, type SourceReader } from "./source-reader.ts";
import type { Layout } from "./ts-tables.ts";

export type Variant = "full" | "preview";
/** Whether a run's source sends data now: it does, it stopped for a while, or nothing is known yet. */
export type Flow = "flowing" | "paused" | "unknown";
export const VARIANTS: readonly Variant[] = ["full", "preview"];

const KILL_GRACE_MS = 3000;
/**
 * The live edge of a source that sends data moves at least this often. The engine's live position
 * moves about once a second as far as the stats showed, and a session only counts as live once its
 * edge kept moving at the broadcast's own pace (see `LiveEdge`), but this was not measured against
 * a real engine, and a few failed stat polls must not look like a pause: if the edge moved less
 * often than this, the wait would keep starting over. A source is stale after 60 s without a move.
 */
const EDGE_FRESH_MS = 20_000;

/**
 * The connection a run reads its source through. A run that takes over from it in the middle of
 * the stream gets the connection too (see `Pipeline`), so the engine's session is read on.
 */
export interface Connection {
  /** Undefined only until the reader is open. */
  reader: SourceReader | undefined;
  /** The run it feeds now. */
  run: Generation;
}

/** What a generation runs: its number, source and output directory, and how ffmpeg reads it. */
export interface GenerationPlan {
  number: number;
  source: string;
  /** The session's stat URL, if the controller sent it. */
  stat?: string | undefined;
  directory: string;
  mode: FullMode;
  /** Decodes every frame, as the broadcast has no key frames to decode alone (see `FfmpegPlan`). */
  allFrames: boolean;
  /** Takes over in the middle of a stream that is already being read (see `FfmpegPlan`). */
  midStream?: boolean;
  startedAt: number;
  inputTimeoutSeconds: number;
}

/** What a pipeline that has no run reports. */
export function statusWithoutRun(
  id: string,
  now: number,
  rest: Pick<PipelineStatus, "layoutChangedAt" | "pendingSource" | "restartedAt">,
): PipelineStatus {
  return {
    id,
    state: "exited",
    source: "",
    startedAt: new Date(now).toISOString(),
    lastFrameAt: null,
    frames: 0,
    fps: null,
    videoCodec: null,
    mode: "copy",
    layout: null,
    exitCode: null,
    error: "not started",
    liveEdge: null,
    ...rest,
  };
}

/** One ffmpeg run of a stream's pipeline, on one source, writing to its own directory. */
export class Generation {
  readonly number: number;
  readonly source: string;
  /** The session's stat URL, if the controller sent it. */
  readonly stat: string | undefined;
  /** Follows the session's live edge; without a stat URL, every segment is published. */
  watch: { readonly edge: LiveEdge; stop: () => void } | undefined;
  /**
   * Per variant, the last segment written before the live edge was seen to move: only later ones
   * are published, so a session that started on an old window never shows any of it.
   */
  readonly publishFrom: Partial<Record<Variant, number>> = {};
  /** When the gate opened (see `publishFrom`). */
  publishingSince: number | undefined;
  /** The last video frame while its output could be published. */
  publishedFrameAt: number | undefined;
  /** A segment of it is in the playlist: until then its frames don't count, players have nothing. */
  published = false;
  /** Its live edge went stale: ffmpeg was stopped, and nothing more of it is published. */
  staleStopped = false;
  readonly directory: string;
  readonly mode: FullMode;
  /** Decodes every frame, as the broadcast has no key frames to decode alone (see `FfmpegPlan`). */
  readonly allFrames: boolean;
  /** Takes over in the middle of a stream that is already being read (see `FfmpegPlan`). */
  readonly midStream: boolean;
  readonly startedAt: number;
  /** How long the source's reader waits for data before it gives up. */
  readonly inputTimeoutSeconds: number;
  process: ChildProcess | undefined;
  /** The connection to its source, while it is the run that connection feeds. */
  connection: Connection | undefined;
  /** Its ffmpeg's input, once ffmpeg started. */
  sink: Sink = NO_SINK;
  /** What the source's program tables say it carries (see `TsTables`): only known of MPEG-TS, once they came. */
  layout: Layout | undefined;
  /**
   * When another run took over from it in the middle of the stream: its input ended there, and
   * the last segments its ffmpeg writes out are still to be published.
   */
  handedOverAt: number | undefined;
  state: PipelineState = "starting";
  frames = 0;
  /** How many frames it had when the broadcast last moved its streams to other PIDs (see `SourceFeeds.onMove`). */
  framesAtMove = 0;
  lastFrameAt: number | undefined;
  fps: number | undefined;
  videoCodec: string | undefined;
  exitCode: number | null = null;
  error: string | null = null;
  readonly stderrTail: string[] = [];
  /** How many more times the source is opened again, by a new run, when this one fails before any video. */
  reopens = 0;
  /** When the handover this run is for began: the first run's start, for a run that reopened. */
  handoverSince: number;
  /** Stopped for good: another generation took its place, or none is needed any more. */
  retired = false;
  /** The run that took over from this one mid-stream, if one did (see `takeOver`). */
  successor: Generation | undefined;
  /** The timer that removes its directory (see `removeLater`). */
  private removal: NodeJS.Timeout | undefined;
  /** Since when the data comes without a break (see `watchFlow`), or none yet. */
  private flowingSince: number | undefined;
  /** The last time the data was seen to come, while `flowingSince` is set. */
  private flowSeenAt = 0;
  /** How long the data came for the stream's earlier runs that got no frame, until it stops for a while. */
  private flowedBefore = 0;

  constructor(plan: GenerationPlan) {
    this.number = plan.number;
    this.source = plan.source;
    this.stat = plan.stat;
    this.directory = plan.directory;
    this.mode = plan.mode;
    this.allFrames = plan.allFrames;
    this.midStream = plan.midStream === true;
    this.startedAt = plan.startedAt;
    this.inputTimeoutSeconds = plan.inputTimeoutSeconds;
    this.handoverSince = plan.startedAt;
  }

  /**
   * Goes on where `old` is in its source, in the middle of the stream: the connection feeds this
   * run from here on, and it is the same attempt on the same session. So it gets what belongs to
   * the session rather than to one ffmpeg run: the live edge's watch, the handover it is part of,
   * the tries left, and the last frame players got (until its own first one, the stream's last
   * frame is still that one, which `old` moves on while it writes out what it has: see
   * `SourceFeeds.drain`). Where `old` could already publish, all of this run's output can:
   * everything it reads comes after what was published.
   */
  takeOver(old: Generation, layout: Layout): void {
    old.successor = this;
    this.layout = layout;
    this.connection = old.connection;
    old.connection = undefined;
    if (this.connection !== undefined) {
      this.connection.run = this;
    }
    this.watch = old.watch;
    old.watch = undefined;
    this.reopens = old.reopens;
    this.handoverSince = old.handoverSince;
    this.publishedFrameAt = old.publishedFrameAt;
    if (old.publishingSince === undefined) {
      return;
    }
    this.publishingSince = old.publishingSince;
    for (const variant of VARIANTS) {
      this.publishFrom[variant] = -1;
    }
  }

  /**
   * Stops its ffmpeg, and the reading of its source while that feeds this run. ffmpeg reads the
   * source from a pipe, and while it waits there for more it acts on no signal: its input ends
   * first, which it notices at once. Otherwise every stop would take until it is killed.
   */
  halt(): void {
    if (this.connection?.run === this) {
      this.connection.reader?.stop();
    }
    this.sink.end();
    killProcess(this.process);
  }

  /**
   * Removes its directory after `ms`, once players can no longer reference it. It is in `waiting`
   * until then. Only the first call counts: a run can be retired twice.
   */
  removeLater(ms: number, waiting: Set<Generation>): void {
    if (this.removal !== undefined) {
      return;
    }
    waiting.add(this);
    this.removal = setTimeout(() => {
      waiting.delete(this);
      void rm(this.directory, { recursive: true, force: true });
    }, ms);
    this.removal.unref();
  }

  /**
   * Ends it as its stream stops: its source is read no more, ffmpeg is killed at once, nothing
   * follows its live edge, and its directory is not removed later by itself (the stream's next
   * pipeline starts with the same directory names, and the stop removes the files of every run).
   * ffmpeg's input ends first, as in `halt`, but it is killed in the same turn, before it sees
   * that: it gets no time to write out what it holds (see `Pipeline.stop`).
   */
  stopNow(): void {
    clearTimeout(this.removal);
    this.error ??= "stopped with its stream";
    if (this.connection?.run === this) {
      this.connection.reader?.stop();
    }
    this.sink.end();
    if (this.process?.exitCode === null && this.process.signalCode === null) {
      this.process.kill("SIGKILL");
    }
    this.watch?.stop();
  }

  /** Whether its output may be published now: its live edge moves, or it has none. */
  publishing(): boolean {
    return !this.staleStopped && (this.watch === undefined || this.watch.edge.publishable());
  }

  stale(): boolean {
    return this.watch?.edge.state() === "stale";
  }

  /**
   * The frame rate its ffmpeg last reported, while that runs. None once it exited or was stopped
   * for a stale source: the last value it printed says nothing about a stream that has no ffmpeg.
   */
  frameRate(): number | null {
    return this.state === "exited" || this.staleStopped ? null : (this.fps ?? null);
  }

  /**
   * Notes whether the broadcast's data comes at `now`: ffmpeg got the stream (it knows its
   * video), the run may publish, and the live edge moved lately (a source without a stat URL has
   * nothing to tell, and counts). It notes when the data began to come, together with how long it
   * came for the stream's earlier runs (`carried`), and starts over, with that too, when it stopped
   * for a while: that is the broadcast pausing.
   */
  watchFlow(now: number, carried: number): Flow {
    // A run that ended keeps what it saw: its flow is handed on when it is replaced (see `flowedMs`).
    if (this.retired || this.state === "exited" || this.frames > 0) {
      return "unknown";
    }
    if (this.videoCodec === undefined || !this.publishing()) {
      this.flowingSince = undefined;
      return "unknown";
    }
    if (!this.edgeMoves()) {
      this.flowingSince = undefined;
      this.flowedBefore = 0;
      return "paused";
    }
    if (this.flowingSince === undefined) {
      this.flowingSince = now;
      this.flowedBefore = Math.max(this.flowedBefore, carried);
    }
    this.flowSeenAt = now;
    return "flowing";
  }

  /**
   * How long the data came without a frame: for this run since it began to come, and for the
   * stream's earlier runs that ended without one. With key frames only decoding, no frame for long
   * means the broadcast has none ffmpeg can use (see `decodesKeyFramesOnly`).
   */
  flowedMs(): number {
    return this.flowedBefore + (this.flowingSince === undefined ? 0 : this.flowSeenAt - this.flowingSince);
  }

  /** Whether the broadcast sends data now, as far as the session's live edge tells (see `LiveEdge`). */
  private edgeMoves(): boolean {
    // A session with no live position has output published as it comes, and nothing to tell either.
    const edge = this.watch?.edge;
    return edge === undefined || edge.state() === "none" || edge.movedWithin(EDGE_FRESH_MS);
  }

  /** Whether its ffmpeg failed before any video, and a new run opens the source again. */
  willReopen(): boolean {
    // A stale source is not opened again: it would only serve the same old window.
    return this.state === "exited" && this.frames === 0 && this.reopens > 0 && !this.retired && !this.staleStopped;
  }
}

export function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export function killProcess(child: ChildProcess | undefined): void {
  if (child?.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, KILL_GRACE_MS);
  timer.unref();
}

export function lastErrorLine(lines: string[], code: number | null): string {
  const interesting = lines.findLast((line) => /error|failed|invalid|timed out|refused/i.test(line));
  return interesting ?? `ffmpeg exited with code ${String(code)}`;
}
