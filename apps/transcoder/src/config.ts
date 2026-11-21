import { envBool, envInt, parseEnv } from "@aceswarm/shared/env";
import { z } from "zod";
import type { PreviewMode } from "./ffmpeg-args.ts";

const schema = z.object({
  PORT: envInt(8081),
  /**
   * Addresses Docker gives containers on the engines network (its ip_range), engines included.
   * Requests from them are refused: engines run untrusted P2P software. The network's gateway
   * address is outside the range, because published ports can arrive through it.
   */
  ENGINE_IP_RANGE: z.cidrv4().default("172.31.250.128/25"),
  HLS_DIR: z.string().default("/hls"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  /**
   * video: smooth low-res preview (decodes every frame).
   * keyframes: decodes only keyframes, about one preview frame per second; far cheaper on CPUs
   * without a hardware H.264 decoder such as the Raspberry Pi 5. A stream whose broadcast has no
   * key frames ffmpeg can use is decoded in full after a while, and one whose full stream is
   * re-encoded always is (see `decodesKeyFramesOnly`).
   */
  PREVIEW_MODE: z.enum(["video", "keyframes"]).default("video"),
  /**
   * The admin allows thumbnails only in the tiles (the controller reads it too), whatever
   * PREVIEW_MODE says: ffmpeg makes no live preview, and decodes key frames only while it copies
   * the full stream (every frame, for a stream whose broadcast has no key frames it can use; see
   * `decodesKeyFramesOnly`). The cheapest.
   */
  LOW_CPU_PREVIEWS: envBool(false),
  PREVIEW_HEIGHT: envInt(360),
  PREVIEW_FPS: envInt(15),
  PREVIEW_BITRATE_KBPS: envInt(600),
  /** Height used when the source codec is not H.264 and the full stream has to be re-encoded. */
  FULL_TRANSCODE_MAX_HEIGHT: envInt(1080),
  AUDIO_BITRATE_KBPS: envInt(160),
  SEGMENT_SECONDS: envInt(2),
  PLAYLIST_SIZE: envInt(6),
  THUMBNAIL_INTERVAL_SECONDS: envInt(10),
  /** How long a new source may take to deliver video while the old one keeps playing. */
  HANDOVER_TIMEOUT_SECONDS: envInt(120),
  /**
   * A source's reader waits this long for data from the engine before giving up (see
   * `readSource`). A handover waits at least HANDOVER_TIMEOUT_SECONDS: a new engine on a slow swarm
   * can take longer than this to deliver.
   */
  INPUT_TIMEOUT_SECONDS: envInt(60),
  /**
   * A source whose live edge (the engine's newest data of the broadcast) did not move for this
   * long is stale: ffmpeg stops reading it, and nothing from it is published. A new source is only
   * published once its live edge moves. Published video older than this leaves the playlist.
   */
  STALE_SOURCE_SECONDS: z.coerce.number().int().min(10).default(60),
  /**
   * An ffmpeg run whose full output wrote no segment for this long, while it still makes video (a
   * frame, a preview segment or a thumbnail), starts again on the same source. ffmpeg holds the
   * segment it writes in memory until it can start the next one, and a copied video can only start
   * one at a key frame, so a broadcast that stops sending those leaves fullscreen without new video
   * while ffmpeg's memory grows. It has to be longer than the broadcasts' longest gap between key
   * frames plus SEGMENT_SECONDS (a copied segment ends at the first key frame after its time is up),
   * and well under the controller's STARTUP_GRACE_SECONDS, which has to cover two stalls.
   */
  FULL_OUTPUT_STALL_SECONDS: z.coerce.number().int().min(10).default(30),
  /**
   * An ffmpeg run whose memory (resident and swapped out) grows by more than this many MB over what
   * it settled at a minute after its first video starts again, whatever the cause. The compose file
   * gives the transcoder no memory limit, so nothing else stops it. How much a run needs depends on
   * the host (more cores start more threads), so the limit is on the growth. 0 turns it off.
   */
  FFMPEG_MAX_MEMORY_GROWTH_MB: z.coerce.number().int().min(0).default(512),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseEnv(schema, env);
}

/** How ffmpeg previews the streams: LOW_CPU_PREVIEWS wins over PREVIEW_MODE. */
export function previewMode(config: Pick<Config, "PREVIEW_MODE" | "LOW_CPU_PREVIEWS">): PreviewMode {
  return config.LOW_CPU_PREVIEWS ? "thumbnails" : config.PREVIEW_MODE;
}
