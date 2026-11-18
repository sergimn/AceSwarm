import { decodesKeyFramesOnly, type FfmpegPlan } from "./ffmpeg-args.ts";
import type { Generation } from "./generation.ts";
import type { ProgressBlock } from "./progress.ts";

/**
 * How long a run that decodes key frames only may read a source without any frame coming of it
 * before the stream is decoded in full (see `decodesKeyFramesOnly`). A broadcast with key frames
 * every few seconds shows its first frame within about 15 s of its first data (30 s with one every
 * 10 s, when the data comes at its own pace); the controller waits 90 s for video.
 */
export const KEY_FRAMES_PATIENCE_MS = 30_000;

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
    const patience = this.allFrames ? 0 : KEY_FRAMES_PATIENCE_MS;
    if (this.worked || !decodesKeyFramesOnly(plan) || !generation.flowedWithoutFrames(now, patience)) {
      return false;
    }
    this.allFrames = true;
    return true;
  }
}
