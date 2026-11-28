/** What the full output does with the video: passes H.264 on as it is, or re-encodes it to H.264. */
export const FULL_MODES = ["copy", "transcode"] as const;
export type FullMode = (typeof FULL_MODES)[number];
/** PREVIEW_MODE's two modes, or thumbnails (no preview) with LOW_CPU_PREVIEWS; see the transcoder's config. */
export type PreviewMode = "video" | "keyframes" | "thumbnails";

export interface FfmpegPlan {
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
  /**
   * Give up on the source after this long without data. Real engines can take 30+ s to start. The
   * source's reader keeps this time (see `readSource`): ffmpeg reads from a pipe, and its own input
   * timeout does not apply to one.
   */
  inputTimeoutSeconds: number;
  /**
   * The run takes over in the middle of a stream that is already being read, as when a broadcast
   * changes its layout (see `Pipeline`). Its data comes at the broadcast's pace, so every second
   * ffmpeg spends looking at the stream before it starts is a second without new video: it looks
   * at one second of it instead of five. The stream's tables come first, so it knows the streams.
   */
  midStream?: boolean;
  /**
   * Decodes every frame, even in keyframes mode: this broadcast gave key frames only decoding no
   * picture to work with (see `decodesKeyFramesOnly`), so it is previewed as in video mode.
   */
  allFrames?: boolean;
}

/**
 * Whether ffmpeg decodes key frames only (`-skip_frame nokey`), which previews the stream for a
 * fraction of the CPU: with `PREVIEW_MODE=keyframes` and with `LOW_CPU_PREVIEWS` (thumbnails mode),
 * while the full stream is copied. It only affects decoding, so the copied full stream keeps every
 * frame. A re-encoded full stream needs every frame decoded, or it would be made of the key frames
 * alone: a picture every few seconds.
 *
 * It needs the broadcast to have key frames that ffmpeg takes for one: IDR frames, or frames with
 * a recovery point (SEI). A broadcast without them (an open GOP whose I frames are no recovery
 * points, or one that refreshes the picture bit by bit instead, as with x264's intra refresh) has
 * none to decode, so ffmpeg writes no preview or thumbnail, and in ffmpeg 9 no progress at all
 * before every output has started. The pipeline then starts the stream again with `allFrames`.
 */
export function decodesKeyFramesOnly(plan: Pick<FfmpegPlan, "previewMode" | "fullMode" | "allFrames">): boolean {
  const keyFrames = plan.previewMode === "keyframes" || plan.previewMode === "thumbnails";
  return keyFrames && plan.fullMode === "copy" && plan.allFrames !== true;
}

/**
 * How many segments ffmpeg keeps on disk beyond the ones its playlist lists: the served playlist
 * lags slightly behind ffmpeg's. So a run's file of a segment is gone once this many and its
 * playlist's size more are written. ffmpeg 9.0.2 keeps no more of them than its playlist lasts,
 * whatever the threshold says (as measured: with a playlist of six segments of two seconds, a
 * threshold of 12 kept seven), so a run keeps more files by listing more in its own playlist.
 */
export const HLS_DELETE_THRESHOLD = 4;

/**
 * How many seconds of a run's newest full segments ffmpeg keeps the files of at least, in the
 * stream's own time: its own playlist lists that much but `HLS_DELETE_THRESHOLD` segments (see
 * `fullFilesKept`), and the playlists served list fewer (`playlistSize`, see `VirtualPlaylist`).
 * VLC 3.0.20 plays 15 seconds or more behind the newest segment, and asked for a segment up to 19
 * seconds after the external playlist listed it, once the stream came back from the slate; a
 * stream that makes up for a pause faster than in real time goes through its files that much
 * sooner. The preview's players play near its newest segment, and keep its six.
 */
const FULL_KEPT_SECONDS = 40;

/**
 * How many of a run's newest full segments ffmpeg keeps the files of, with a playlist of
 * `playlistSize` and segments of `segmentSeconds`: twenty of two seconds, forty of one (measured
 * with ffmpeg 9.0.2). A copied stream whose key frames are further apart than that has longer
 * segments, and so keeps more of its video.
 */
export function fullFilesKept(playlistSize: number, segmentSeconds: number): number {
  return Math.max(playlistSize + HLS_DELETE_THRESHOLD, Math.ceil(FULL_KEPT_SECONDS / segmentSeconds));
}

function hlsOutput(plan: FfmpegPlan, variant: "full" | "preview"): string[] {
  const directory = `${plan.directory}/${variant}`;
  const listed =
    variant === "full"
      ? fullFilesKept(plan.playlistSize, plan.segmentSeconds) - HLS_DELETE_THRESHOLD
      : plan.playlistSize;
  return [
    "-f",
    "hls",
    "-hls_time",
    String(plan.segmentSeconds),
    "-hls_list_size",
    String(listed),
    "-hls_delete_threshold",
    String(HLS_DELETE_THRESHOLD),
    "-hls_flags",
    "delete_segments+independent_segments+temp_file",
    "-hls_segment_filename",
    `${directory}/seg_%06d.ts`,
    `${directory}/index.m3u8`,
  ];
}

/**
 * The preview's filter. Key frames are sparse already, so `keyframes` mode only scales them. With
 * every frame decoded, the preview keeps the first frame of each 1/`previewFps` second slot of the
 * stream's time and scales only those, which costs what the `fps` filter did.
 *
 * It must not use the `fps` filter: when the video has a gap in its timestamps, `fps` repeats a
 * frame, and then ffmpeg 9's scheduler can deadlock for good (every thread waits, nothing is read
 * or written, ffmpeg never exits). `select` never repeats a frame, and the frame rate on the output
 * (see `previewFrameRate`) repeats it after the graph. The details are in the architecture notes
 * ("ffmpeg and gaps in the video's timestamps"), and `test/ffmpeg-gaps.test.ts` runs the real ffmpeg.
 */
function previewFilter(plan: FfmpegPlan): string {
  const scale = `scale=-2:${String(plan.previewHeight)}`;
  if (decodesKeyFramesOnly(plan)) {
    return scale;
  }
  const slot = (time: string): string => `floor(${time}*${String(plan.previewFps)})`;
  return `select='isnan(prev_selected_t)+gt(${slot("t")},${slot("prev_selected_t")})',${scale}`;
}

/** Sets the preview's frame rate on the output, where ffmpeg repeats a frame outside the graph. */
function previewFrameRate(plan: FfmpegPlan): string[] {
  return decodesKeyFramesOnly(plan) ? [] : ["-r", String(plan.previewFps), "-fps_mode", "cfr"];
}

function keyframeEvery(plan: FfmpegPlan): string[] {
  return ["-force_key_frames", `expr:gte(t,n_forced*${String(plan.segmentSeconds)})`];
}

/**
 * Builds the ffmpeg command line for one generation of a stream. The engine allows a single
 * reader per stream, so one ffmpeg process gets it once, on its standard input from the source's
 * reader (see `readSource`), and produces every output:
 *
 * - full: original video when it is H.264 (no re-encode), otherwise H.264; audio to AAC so every
 *   browser can play it.
 * - preview: small H.264 rendition for the grid, no audio. None in thumbnails mode, which saves
 *   its encode: its playlist then stays empty.
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
    plan.midStream === true ? "1000000" : "5000000",
    "-probesize",
    "5000000",
  ];
  if (decodesKeyFramesOnly(plan)) {
    // Only affects decoding (preview and thumbnail); the copied full stream keeps every frame. In
    // thumbnails mode with a copied full stream, ffmpeg 7 and later count the copied frames, 6.x
    // counts 0.
    input.push("-skip_frame", "nokey");
  }
  input.push("-i", "pipe:0");

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

  const bitrate = plan.previewBitrateKbps;
  const preview = [
    "-map",
    "0:v:0",
    "-vf",
    previewFilter(plan),
    ...previewFrameRate(plan),
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

  // The first thumbnail is written with the first frame, and one every interval after it. Left at
  // its defaults, the fps filter holds the first frame until half an interval of video has passed
  // (it rounds to the nearest slot), and ffmpeg 9 prints no -progress before every output has a
  // frame, so the transcoder saw no frame for that long after each start. `round=up` takes a frame
  // as soon as its slot begins. `start_time=0` makes the filter pad from the first frame when the
  // video starts a little after the audio: its first timestamp is then above zero, and `round=up`
  // alone would put it in the next slot and hold it for a whole interval. The mjpeg encoder holds
  // each picture until the next one arrives, unless it runs on one thread.
  const thumbnail = [
    "-map",
    "0:v:0",
    "-vf",
    `fps=1/${String(plan.thumbnailIntervalSeconds)}:round=up:start_time=0,scale=-2:180`,
    "-threads",
    "1",
    "-q:v",
    "6",
    "-update",
    "1",
    "-f",
    "image2",
    `${plan.directory}/thumbnail.jpg`,
  ];

  return [...input, ...full, ...(plan.previewMode === "thumbnails" ? [] : preview), ...thumbnail];
}
