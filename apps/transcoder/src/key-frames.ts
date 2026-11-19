import { decodesKeyFramesOnly, type FfmpegPlan } from "./ffmpeg-args.ts";
import type { Generation } from "./generation.ts";
import type { ProgressBlock } from "./progress.ts";

/**
 * How long a run that decodes key frames only may read a source without any frame coming of it
 * before the stream is decoded in full (see `decodesKeyFramesOnly`). With ffmpeg 9 the first frame
 * of a broadcast that has key frames comes after up to about 3.5 to 4 times their interval,
 * counted from the start of the run (measured on a 720p x264 test source: about 17 s for key
 * frames every 5 s, 34 to 40 s for every 10 s, 48 s for every 12 s, 60 s for every 15 s; about
 * twice the interval for a small, fast one, so it depends on bitrate and encoder). The wait begins after the run opened and probed the
 * source, about 5 s in, so key frames up to about 12 s apart get their frame in time and those
 * further apart are decoded in full too. The controller waits 90 s for video, counted from when
 * the session opens, so the swarm's prebuffering uses up part of it: when the data starts late the
 * controller starts the stream's pipeline again before the fallback or its first frame came. What
 * came counts for the next run (see `KeyFrames.carried`), so the fallback comes all the same.
 */
export const KEY_FRAMES_PATIENCE_MS = 45_000;

/**
 * How many times ffmpeg opens the source again when its run that decodes every frame fails before
 * any video: the engine allows one reader per session, and may still refuse a new one for a
 * moment after the run it replaces let go.
 */
export const REOPENS_AFTER_FALLBACK = 5;

/**
 * What a stream's pipeline knows about the key frames of its broadcast: whether it needs every
 * frame decoded, because key frames only decoding gave it no picture, or has shown that it has
 * key frames ffmpeg can use.
 */
export class KeyFrames {
  /**
   * Decodes every frame from now on, though the previews wanted key frames only. It is the
   * broadcast's trait, so it stays for every source of the stream.
   */
  allFrames = false;
  /** A run got a frame with key frames only decoding: a source that gives none is slow, not the trait. */
  private worked = false;
  /**
   * How long the data came for the stream's runs that ended without a frame (the controller starts
   * the stream again when it takes a long time to show video), so that a broadcast whose data
   * starts late still reaches the patience. The next runs start from it.
   */
  carried = 0;

  /**
   * Notes a progress block of a run. The last one ffmpeg prints as it is stopped says nothing: it
   * comes with the frames it copied, though it printed no block before.
   */
  progressed(block: ProgressBlock, plan: FfmpegPlan): void {
    this.worked ||= block.progress === "continue" && decodesKeyFramesOnly(plan);
  }

  /**
   * Whether the run is to be replaced by one that decodes every frame, as the data came for the
   * patience without a frame of key frames only decoding. Then so are all the stream's later runs,
   * and a run that began before this needs no patience.
   */
  fallBack(generation: Generation, plan: FfmpegPlan, now: number): boolean {
    if (this.worked || !decodesKeyFramesOnly(plan)) {
      return false;
    }
    const flow = generation.watchFlow(now, this.carried);
    if (flow === "paused") {
      this.carried = 0;
    }
    const patience = this.allFrames ? 0 : KEY_FRAMES_PATIENCE_MS;
    if (flow !== "flowing" || generation.flowedMs() < patience) {
      return false;
    }
    this.allFrames = true;
    return true;
  }

  /**
   * A run ends: it hands on how long the data came for it (see `carried`). With a frame of key
   * frames only decoding the fallback is off for good (`worked`), so that does no harm.
   */
  ended(generation: Generation): void {
    this.carried = Math.max(this.carried, generation.flowedMs());
  }
}
