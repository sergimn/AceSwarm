import type { ChildProcess } from "node:child_process";
import type { FfmpegPlan } from "./ffmpeg-args.ts";
import type { LiveEdgeSettings, WatchLiveEdge } from "./live-edge.ts";
import type { OnSegment } from "./playlist.ts";
import type { OpenSource } from "./source-reader.ts";
import type { MemoryReader, StuckLimits } from "./stuck-runs.ts";
import type { LayoutChangeKind } from "./ts-tables.ts";

/** What every ffmpeg run of a pipeline does, other than what each run decides for itself. */
export type PlanSettings = Omit<FfmpegPlan, "directory" | "fullMode" | "allFrames" | "midStream">;

export interface PipelineSettings {
  hlsDir: string;
  ffmpegPath: string;
  handoverTimeoutMs: number;
  plan: PlanSettings;
  /**
   * When a source's live edge counts as stale (see `LiveEdge`). Published segments older than its
   * `staleAfterMs` also leave the playlist, so a player never starts on old video.
   */
  liveEdge?: LiveEdgeSettings;
  /** When a run that goes on is stuck, and started again (see `StuckRuns`). */
  stuck?: StuckLimits;
}

export interface PipelineEvents {
  generationStarted: (id: string, reason: string) => void;
  handover: (id: string, result: "promoted" | "failed") => void;
  /**
   * The broadcast changed the layout of the source players get, mid-stream, and ffmpeg followed
   * it: a new run took over (`new`), or the same one reads on over a move to other PIDs (`same`).
   */
  layoutChanged: (id: string, kind: LayoutChangeKind, run: "new" | "same") => void;
  /**
   * Players got the first frame after such a change, `ms` after the last one they got before it
   * (see `Generation.show`).
   */
  layoutGap: (id: string, ms: number) => void;
  /** The full output's playlist took a segment: players can get it from now on. */
  fullSegment?: OnSegment;
}

export type Spawner = (command: string, args: string[]) => ChildProcess;

/** What tests replace: how ffmpeg starts, the clock, and how a source is read and its live edge followed. */
export interface PipelineOptions {
  spawner?: Spawner | undefined;
  now?: () => number;
  watchLiveEdge?: WatchLiveEdge;
  openSource?: OpenSource | undefined;
  /** How much memory an ffmpeg process holds (see `StuckLimits.maxMemoryGrowthBytes`). */
  memoryOf?: MemoryReader;
}
