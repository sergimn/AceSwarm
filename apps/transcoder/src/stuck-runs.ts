import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { modifiedAt, type Generation } from "./generation.ts";

/** When an ffmpeg run that still goes on counts as stuck (see `StuckRuns`). */
export interface StuckLimits {
  /** For how long its full output may write no segment while the run still makes video. */
  fullOutputStallMs: number;
  /**
   * How much more memory (resident and swapped out, in bytes) the run may hold than it settled at
   * a minute after its first video (see `MEMORY_SETTLES_MS`): 0 for no limit.
   */
  maxMemoryGrowthBytes: number;
}

export const DEFAULT_STUCK_LIMITS: StuckLimits = { fullOutputStallMs: 30_000, maxMemoryGrowthBytes: 512 * 1024 * 1024 };

/** Why a run is started again, as the reason of its successor (see `PipelineEvents.generationStarted`). */
export type StuckReason = "full-output-stalled" | "memory";

/**
 * How soon after a run was found with its full output stalled the run that replaced it has to be
 * found so too, without a full segment of its own, for the full stream to be re-encoded (see
 * `Stuck.reencode`). Its start, ffmpeg's probe of the source and the stall time fit well within it.
 */
export const STALLED_AGAIN_WITHIN_MS = 5 * 60_000;

/**
 * How long after its first video a run's memory is what it needs: ffmpeg sets up its decoders,
 * encoders and their threads in the first seconds, and holds about that much from then on. A
 * re-encoded 1080p stream takes about 400 MB on 4 cores, and about 1.1 GB on 24 or more, as x264
 * and the decoder start more threads; a copy takes about 100 MB.
 */
export const MEMORY_SETTLES_MS = 60_000;

export interface Stuck {
  reason: StuckReason;
  /**
   * The full output stalled again right after a restart, with a copied video that never gave it a
   * segment: the broadcast has no key frames to cut it at, so a copy would only stall again. The
   * full stream is to be re-encoded, which makes key frames of its own (see `StuckRuns.copyFails`).
   */
  reencode: boolean;
  message: string;
  /** What the log shows with the message. */
  details: Record<string, number>;
}

/** Reads how much memory a process holds (see `StuckLimits.maxMemoryGrowthBytes`); undefined if it can't tell. */
export type MemoryReader = (pid: number) => number | undefined;

/** What the checks saw of a run so far, by the clock of `StuckRuns`. */
interface Seen {
  /** Its frame count and the modification times of its preview and thumbnail: a change is video it made. */
  video: string;
  /** The modification time of its full output's playlist: a change is a segment it wrote. */
  full: number | undefined;
  /** When a check first saw it make video, and when one last did. */
  videoSince: number | undefined;
  videoAt: number | undefined;
  /** When a check last saw its full output write a segment. */
  fullAt: number | undefined;
  /** How much memory it held once it settled (see `MEMORY_SETTLES_MS`). */
  settled: number | undefined;
}

/** What a run that has made nothing yet looks like (see `Seen.video`). */
const NOTHING = "0||";

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
 * - **Its memory keeps growing**, for that reason or any other: by more than `maxMemoryGrowthBytes`
 *   over what it settled at. How much a run needs depends on the host (see `MEMORY_SETTLES_MS`),
 *   so the limit is on what it takes on top of that.
 *
 * It is told about the run every second or so (see `check`), and goes by what changed since: when
 * a file was last written counts by its own clock, which is monotonic, so that a step of the
 * system's clock (a machine without a clock battery sets it once it is online) is no stall.
 */
export class StuckRuns {
  /**
   * A copy of the stream's video got no segment into the full output, again right after a restart
   * (see `Stuck.reencode`): the stream's later runs re-encode it, whatever its codec.
   */
  copyFails = false;
  private readonly limits: StuckLimits;
  private readonly memoryOf: MemoryReader;
  private readonly now: () => number;
  private readonly seen = new WeakMap<Generation, Seen>();
  /** When the last run whose full output stalled was found so. */
  private lastStallAt: number | undefined;

  constructor(limits: StuckLimits, memoryOf: MemoryReader = processMemory, now = (): number => performance.now()) {
    this.limits = limits;
    this.memoryOf = memoryOf;
    this.now = now;
  }

  /** Whether the run is stuck now, and why; undefined while it is fine or not running. */
  check(generation: Generation): Stuck | undefined {
    const pid = generation.process?.pid;
    if (generation.retired || generation.staleStopped || generation.state === "exited" || pid === undefined) {
      return undefined;
    }
    const now = this.now();
    const seen = this.look(generation, now);
    return this.overMemory(pid, seen, now) ?? this.fullOutputStalled(generation, seen, now);
  }

  /** Notes what the run made since the last check. */
  private look(generation: Generation, now: number): Seen {
    const { directory } = generation;
    const preview = modifiedAt(join(directory, "preview", "index.m3u8"));
    const thumbnail = modifiedAt(join(directory, "thumbnail.jpg"));
    const video = `${String(generation.frames)}|${String(preview ?? "")}|${String(thumbnail ?? "")}`;
    const full = modifiedAt(join(directory, "full", "index.m3u8"));
    const seen = this.seen.get(generation) ?? {
      video: NOTHING,
      full: undefined,
      videoSince: undefined,
      videoAt: undefined,
      fullAt: undefined,
      settled: undefined,
    };
    this.seen.set(generation, seen);
    if (video !== seen.video) {
      seen.video = video;
      seen.videoSince ??= now;
      seen.videoAt = now;
    }
    if (full !== seen.full) {
      seen.full = full;
      seen.fullAt = now;
    }
    return seen;
  }

  private overMemory(pid: number, seen: Seen, now: number): Stuck | undefined {
    const limit = this.limits.maxMemoryGrowthBytes;
    const settling = seen.videoSince === undefined || now - seen.videoSince < MEMORY_SETTLES_MS;
    const memory = limit > 0 && !settling ? this.memoryOf(pid) : undefined;
    if (memory === undefined) {
      return undefined;
    }
    seen.settled ??= memory;
    if (memory - seen.settled <= limit) {
      return undefined;
    }
    return {
      reason: "memory",
      reencode: false,
      message: "ffmpeg's memory keeps growing; starting it again",
      details: { memoryMb: megabytes(memory), settledMb: megabytes(seen.settled), limitMb: megabytes(limit) },
    };
  }

  private fullOutputStalled(generation: Generation, seen: Seen, now: number): Stuck | undefined {
    const { videoSince, videoAt, fullAt } = seen;
    if (videoSince === undefined || videoAt === undefined) {
      return undefined;
    }
    const lagMs = videoAt - Math.max(videoSince, fullAt ?? -Infinity);
    if (lagMs < this.limits.fullOutputStallMs) {
      return undefined;
    }
    const reencode =
      generation.mode === "copy" &&
      fullAt === undefined &&
      this.lastStallAt !== undefined &&
      now - this.lastStallAt <= STALLED_AGAIN_WITHIN_MS;
    this.lastStallAt = now;
    this.copyFails ||= reencode;
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
