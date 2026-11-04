export type FullMode = "copy" | "transcode";
export type PreviewMode = "video" | "keyframes";

export interface FfmpegPlan {
  source: string;
  /** Generation directory; outputs go to `full/`, `preview/` and `thumbnail.jpg` inside it. */
  directory: string;
  fullMode: FullMode;
  previewMode: PreviewMode;
  previewHeight: number;
  previewFps: number;
  previewBitrateKbps: number;
  fullTranscodeMaxHeight: number;
  audioBitrateKbps: number;
  segmentSeconds: number;
  playlistSize: number;
  thumbnailIntervalSeconds: number;
  /** Give up on the source after this long without data. Real engines can take 30+ s to start. */
  inputTimeoutSeconds: number;
}

function hlsOutput(plan: FfmpegPlan, variant: "full" | "preview"): string[] {
  const directory = `${plan.directory}/${variant}`;
  return [
    "-f",
    "hls",
    "-hls_time",
    String(plan.segmentSeconds),
    "-hls_list_size",
    String(plan.playlistSize),
    // Keep a few extra segments on disk: the served playlist lags slightly behind ffmpeg's.
    "-hls_delete_threshold",
    "4",
    "-hls_flags",
    "delete_segments+independent_segments+temp_file",
    "-hls_segment_filename",
    `${directory}/seg_%06d.ts`,
    `${directory}/index.m3u8`,
  ];
}

function keyframeEvery(plan: FfmpegPlan): string[] {
  return ["-force_key_frames", `expr:gte(t,n_forced*${String(plan.segmentSeconds)})`];
}

/**
 * Builds the ffmpeg command line for one generation of a stream. The engine allows a single
 * reader per stream, so one ffmpeg process reads it once and produces every output:
 *
 * - full: original video when it is H.264 (no re-encode), otherwise H.264; audio to AAC so every
 *   browser can play it.
 * - preview: small H.264 rendition for the grid, no audio.
 * - thumbnail.jpg: refreshed every few seconds, used as a poster.
 */
export function buildFfmpegArgs(plan: FfmpegPlan): string[] {
  const input = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-progress",
    "pipe:1",
    "-stats_period",
    "1",
    "-fflags",
    "+genpts+discardcorrupt",
    "-analyzeduration",
    "5000000",
    "-probesize",
    "5000000",
    "-rw_timeout",
    String(plan.inputTimeoutSeconds * 1_000_000),
  ];
  if (plan.previewMode === "keyframes") {
    // Only affects decoding (preview and thumbnail); the copied full stream keeps every frame.
    input.push("-skip_frame", "nokey");
  }
  input.push("-i", plan.source);

  const fullVideo =
    plan.fullMode === "copy"
      ? ["-c:v", "copy"]
      : [
          "-vf",
          `scale=-2:'min(${String(plan.fullTranscodeMaxHeight)},ih)'`,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "21",
          "-pix_fmt",
          "yuv420p",
          ...keyframeEvery(plan),
        ];
  const full = [
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    ...fullVideo,
    "-c:a",
    "aac",
    "-b:a",
    `${String(plan.audioBitrateKbps)}k`,
    "-ac",
    "2",
    ...hlsOutput(plan, "full"),
  ];

  const previewFilter =
    plan.previewMode === "keyframes"
      ? `scale=-2:${String(plan.previewHeight)}`
      : `fps=${String(plan.previewFps)},scale=-2:${String(plan.previewHeight)}`;
  const bitrate = plan.previewBitrateKbps;
  const preview = [
    "-map",
    "0:v:0",
    "-vf",
    previewFilter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    `${String(bitrate)}k`,
    "-maxrate",
    `${String(Math.round(bitrate * 1.2))}k`,
    "-bufsize",
    `${String(bitrate * 2)}k`,
    ...keyframeEvery(plan),
    "-an",
    ...hlsOutput(plan, "preview"),
  ];

  const thumbnail = [
    "-map",
    "0:v:0",
    "-vf",
    `fps=1/${String(plan.thumbnailIntervalSeconds)},scale=-2:180`,
    "-q:v",
    "6",
    "-update",
    "1",
    "-f",
    "image2",
    `${plan.directory}/thumbnail.jpg`,
  ];

  return [...input, ...full, ...preview, ...thumbnail];
}
