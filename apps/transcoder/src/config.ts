import { envInt, parseEnv } from "@aceswarm/shared/env";
import { z } from "zod";

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
   * without a hardware H.264 decoder such as the Raspberry Pi 5.
   */
  PREVIEW_MODE: z.enum(["video", "keyframes"]).default("video"),
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
   * ffmpeg waits this long for data from the engine before giving up. A handover waits at least
   * HANDOVER_TIMEOUT_SECONDS: a new engine on a slow swarm can take longer than this to deliver.
   */
  INPUT_TIMEOUT_SECONDS: envInt(60),
  /**
   * A source whose live edge (the engine's newest data of the broadcast) did not move for this
   * long is stale: ffmpeg stops reading it, and nothing from it is published. A new source is only
   * published once its live edge moves. Published video older than this leaves the playlist.
   */
  STALE_SOURCE_SECONDS: z.coerce.number().int().min(10).default(60),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseEnv(schema, env);
}
