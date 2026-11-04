import { createLogger } from "@aceswarm/shared/logger";
import { createService, runService } from "@aceswarm/shared/service";
import { loadConfig } from "./config.ts";
import { PipelineManager, registerRoutes } from "./server.ts";

const config = loadConfig();
const logger = createLogger("transcoder");
const service = createService({ name: "transcoder", logger });

const manager = new PipelineManager(
  service,
  {
    hlsDir: config.HLS_DIR,
    ffmpegPath: config.FFMPEG_PATH,
    handoverTimeoutMs: config.HANDOVER_TIMEOUT_SECONDS * 1000,
    plan: {
      previewMode: config.PREVIEW_MODE,
      previewHeight: config.PREVIEW_HEIGHT,
      previewFps: config.PREVIEW_FPS,
      previewBitrateKbps: config.PREVIEW_BITRATE_KBPS,
      fullTranscodeMaxHeight: config.FULL_TRANSCODE_MAX_HEIGHT,
      audioBitrateKbps: config.AUDIO_BITRATE_KBPS,
      segmentSeconds: config.SEGMENT_SECONDS,
      playlistSize: config.PLAYLIST_SIZE,
      thumbnailIntervalSeconds: config.THUMBNAIL_INTERVAL_SECONDS,
      inputTimeoutSeconds: config.INPUT_TIMEOUT_SECONDS,
    },
  },
  logger,
);

await manager.clean();
registerRoutes(service, manager);
await runService(service, config.PORT, logger, () => manager.stopAll());
logger.info({ port: config.PORT, previewMode: config.PREVIEW_MODE }, "transcoder ready");
