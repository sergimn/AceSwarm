import { envInt, parseEnv } from "@aceswarm/shared/env";
import { z } from "zod";

const schema = z.object({
  PORT: envInt(8081),
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
  HANDOVER_TIMEOUT_SECONDS: envInt(120),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseEnv(schema, env);
}
