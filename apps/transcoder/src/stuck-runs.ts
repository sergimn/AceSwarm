import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modifiedAt, type Generation } from "./generation.ts";

/** When an ffmpeg run that still goes on counts as stuck (see `StuckRuns`). */
export interface StuckLimits {
  /** How long its full output may write no segment while the run still makes video. */
  fullOutputStallMs: number;
  /** How much memory the run may hold, resident and swapped out, in bytes: 0 for no limit. */
  maxMemoryBytes: number;
}

export const DEFAULT_STUCK_LIMITS: StuckLimits = { fullOutputStallMs: 30_000, maxMemoryBytes: 1024 * 1024 * 1024 };

/** Why a run is started again, as the reason of its successor (see `PipelineEvents.generationStarted`). */
export type StuckReason = "full-output-stalled" | "memory";

/**
 * How soon after a run was found with its full output stalled the run that replaced it has to be
 * found so too, without a full segment of its own, for the full stream to be re-encoded (see
 * `Stuck.reencode`). Its start, ffmpeg's probe of the source and the stall time fit well within it.
 */
export const STALLED_AGAIN_WITHIN_MS = 5 * 60_000;

export interface Stuck {
  reason: StuckReason;
  /**
   * The full output stalled again right after a restart, with a copied video that never gave it a
   * segment: the broadcast has no key frames to cut it at, so a copy would only stall again. The
   * full stream is to be re-encoded, which makes key frames of its own.
   */
  reencode: boolean;
  message: string;
  /** What the log shows with the message. */
  details: Record<string, number>;
}

/** Reads how much memory a process holds (see `StuckLimits.maxMemoryBytes`); undefined if it can't tell. */
export type MemoryReader = (pid: number) => number | undefined;

function readStatus(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${String(pid)}/status`, "utf8");
  } catch {
    return undefined;
  }
}

const megabytes = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** Resident and swapped-out memory of a process, from Linux's /proc; undefined elsewhere or once it is gone. */
export const processMemory: MemoryReader = (pid) => {
  const status = readStatus(pid);
  if (status === undefined) {
    return undefined;
  }
  const kilobytes = (field: string): number =>
    Number(new RegExp(String.raw`^${field}:\s+(\d+) kB`, "m").exec(status)?.[1] ?? 0);
  const resident = kilobytes("VmRSS");
  return resident === 0 ? undefined : (resident + kilobytes("VmSwap")) * 1024;
};

/**
 * Finds ffmpeg runs that go on but are of no use, or about to do harm, so that the pipeline starts
 * them again on the same source:
 *
 * - **Its full output stopped.** ffmpeg's HLS muxer holds the segment it writes in memory, and
 *   writes it out only when it starts the next one. A copied video can only start one at a key
 *   frame as ffmpeg sees it (for H.264: an IDR frame, a frame with a recovery point, or an I frame
 *   with a single reference), so when the broadcast stops sending those, the full output writes
 *   nothing more while the preview and thumbnail go on, as does ffmpeg's frame count (it counts the
 *   frames it hands that muxer). Players get no new video, and the segment grows in memory by the
 *   stream's bitrate until ffmpeg ends, then fills the HLS folder when it is written out at once.
 *   So a run whose full output wrote no segment for `fullOutputStallMs`, while it still made video
 *   (a frame, a preview segment or a thumbnail) after that long, is stuck. A run that makes no
 *   video at all is not: the source stopped, and the controller deals with that.
 *   When the run that replaced it stalls too, soon after and without a full segment of its own,
 *   the broadcast has no key frames to cut a copy at (ffmpeg drops a copied video's frames before
 *   its first key frame, so the full output gets none at all), and the full stream is re-encoded.
 * - **It holds too much memory**, for that reason or any other: past `maxMemoryBytes`.
 *
 * It is told about the run every second or so (see `check`).
 */
export class StuckRuns {
  private readonly limits: StuckLimits;
  private readonly memoryOf: MemoryReader;
  /** When each run was first seen making video. */
  private readonly videoSince = new WeakMap<Generation, number>();
  /** When the last run whose full output stalled still made video, as it was found. */
  private lastStallAt: number | undefined;

  constructor(limits: StuckLimits, memoryOf: MemoryReader = processMemory) {
    this.limits = limits;
    this.memoryOf = memoryOf;
  }

  /** Whether the run is stuck now, and why; undefined while it is fine or not running. */
  check(generation: Generation): Stuck | undefined {
    const pid = generation.process?.pid;
    return generation.retired || generation.staleStopped || generation.state === "exited" || pid === undefined
      ? undefined
      : (this.overMemory(pid) ?? this.fullOutputStalled(generation));
  }

  private overMemory(pid: number): Stuck | undefined {
    const limit = this.limits.maxMemoryBytes;
    const memory = limit > 0 ? this.memoryOf(pid) : undefined;
    if (memory === undefined || memory <= limit) {
      return undefined;
    }
    return {
      reason: "memory",
      reencode: false,
      message: "ffmpeg holds too much memory; starting it again",
      details: { memoryMb: megabytes(memory), limitMb: megabytes(limit) },
    };
  }

  private fullOutputStalled(generation: Generation): Stuck | undefined {
    const { directory } = generation;
    const madeVideoAt = Math.max(
      generation.lastFrameAt ?? -Infinity,
      modifiedAt(join(directory, "preview", "index.m3u8")) ?? -Infinity,
      modifiedAt(join(directory, "thumbnail.jpg")) ?? -Infinity,
    );
    if (madeVideoAt === -Infinity) {
      return undefined;
    }
    const since = this.videoSince.get(generation) ?? madeVideoAt;
    this.videoSince.set(generation, since);
    const fullWrittenAt = modifiedAt(join(directory, "full", "index.m3u8"));
    const lagMs = madeVideoAt - Math.max(since, fullWrittenAt ?? -Infinity);
    if (lagMs < this.limits.fullOutputStallMs) {
      return undefined;
    }
    const reencode =
      generation.mode === "copy" &&
      fullWrittenAt === undefined &&
      this.lastStallAt !== undefined &&
      madeVideoAt - this.lastStallAt <= STALLED_AGAIN_WITHIN_MS;
    this.lastStallAt = madeVideoAt;
    return {
      reason: "full-output-stalled",
      reencode,
      message: reencode
        ? "the full output wrote no segment again after a restart: the copied video has no key frames to cut it at; re-encoding it"
        : "the full output wrote no segment while ffmpeg still made video; starting it again",
      details: { seconds: Math.round(lagMs / 1000), frames: generation.frames },
    };
  }
}
