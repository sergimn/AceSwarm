import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import type { PipelineState } from "@aceswarm/shared/api-types";
import type { FullMode } from "./ffmpeg-args.ts";
import type { LiveEdge } from "./live-edge.ts";

export type Variant = "full" | "preview";
export const VARIANTS: readonly Variant[] = ["full", "preview"];

const KILL_GRACE_MS = 3000;
/** The live edge of a source that sends data moves at least this often. */
const EDGE_FRESH_MS = 10_000;

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
  startedAt: number;
  inputTimeoutSeconds: number;
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
  readonly startedAt: number;
  /** How long ffmpeg waits for data from the source before it gives up. */
  readonly inputTimeoutSeconds: number;
  process: ChildProcess | undefined;
  state: PipelineState = "starting";
  frames = 0;
  lastFrameAt: number | undefined;
  fps: number | undefined;
  videoCodec: string | undefined;
  exitCode: number | null = null;
  error: string | null = null;
  readonly stderrTail: string[] = [];
  /** How many more times ffmpeg opens the source again when this run fails before any video. */
  reopens = 0;
  /** When the handover this run is for began: the first run's start, for a run that reopened. */
  handoverSince: number;
  /** Stopped for good: another generation took its place, or none is needed any more. */
  retired = false;
  /** Since when the data comes without a break (see `flowedWithoutFrames`), or none yet. */
  flowingSince: number | undefined;

  constructor(plan: GenerationPlan) {
    this.number = plan.number;
    this.source = plan.source;
    this.stat = plan.stat;
    this.directory = plan.directory;
    this.mode = plan.mode;
    this.allFrames = plan.allFrames;
    this.startedAt = plan.startedAt;
    this.inputTimeoutSeconds = plan.inputTimeoutSeconds;
    this.handoverSince = plan.startedAt;
  }

  /** Whether its output may be published now: its live edge moves, or it has none. */
  publishing(): boolean {
    return !this.staleStopped && (this.watch === undefined || this.watch.edge.publishable());
  }

  stale(): boolean {
    return this.watch?.edge.state() === "stale";
  }

  /**
   * Whether no frame came for `patienceMs` though the data came the whole time: ffmpeg opened the
   * source (it knows its video), and the broadcast sent new data (the live edge moved lately; a
   * source without a stat URL has nothing to tell, and counts). It notes when the data began to
   * come, and starts over when it stopped for a while. With key frames only decoding, no frame
   * means the broadcast has none ffmpeg can use (see `decodesKeyFramesOnly`).
   */
  flowedWithoutFrames(now: number, patienceMs: number): boolean {
    const idle = this.retired || this.state === "exited" || this.frames > 0;
    const flowing = this.videoCodec !== undefined && this.publishing() && this.edgeMoves();
    if (idle || !flowing) {
      this.flowingSince = undefined;
      return false;
    }
    this.flowingSince ??= now;
    return now - this.flowingSince >= patienceMs;
  }

  private edgeMoves(): boolean {
    return this.watch?.edge.movedWithin(EDGE_FRESH_MS) ?? true;
  }

  /** Whether ffmpeg failed before any video, and opens the source again. */
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
