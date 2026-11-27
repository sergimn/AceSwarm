import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Slate } from "./external-playlist.ts";
import { parseMediaPlaylist } from "./playlist.ts";

/**
 * The slate's picture, 1280x720, with its words in it: the image has no font for ffmpeg to write
 * them with.
 */
export const SLATE_PICTURE = fileURLToPath(new URL("../assets/slate.png", import.meta.url));
/** The slate's folder next to the streams' own. No stream has this name: an id has no underscore. */
export const SLATE_DIRECTORY = "_slate";
/** The name the slate's segments have in a stream's playlists, in place of an ffmpeg run's `g<n>/full`. */
export const SLATE_NAME = "slate";
/**
 * How long the loop is. It starts over behind a discontinuity, which costs a player a moment (VLC
 * starts its decoders again), so it is no shorter; as it is, ffmpeg makes it in a few seconds, and
 * it takes a third of a megabyte.
 */
const LOOP_SECONDS = 30;
/** Making it takes seconds; a run that takes this long hangs. */
const TIMEOUT_MS = 120_000;

export interface SlateSettings {
  ffmpegPath: string;
  /** The folder the streams' folders are in. */
  hlsDir: string;
  segmentSeconds: number;
  audioBitrateKbps: number;
  picture?: string;
}

/**
 * The ffmpeg command line that makes the slate: the picture as H.264 with silent AAC sound, in
 * segments like the full output's, so a player goes from one to the other as it goes from one
 * ffmpeg run of the stream to the next. 25 frames a second, as most broadcasts have.
 */
export function slateArgs(settings: SlateSettings, directory: string): string[] {
  const seconds = String(settings.segmentSeconds);
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-loop",
    "1",
    "-framerate",
    "25",
    "-i",
    settings.picture ?? SLATE_PICTURE,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-t",
    String(LOOP_SECONDS),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    `expr:gte(t,n_forced*${seconds})`,
    "-c:a",
    "aac",
    "-b:a",
    `${String(settings.audioBitrateKbps)}k`,
    "-ac",
    "2",
    "-f",
    "hls",
    "-hls_time",
    seconds,
    "-hls_list_size",
    "0",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    join(directory, "seg_%03d.ts"),
    join(directory, "index.m3u8"),
  ];
}

export type RunFfmpeg = (command: string, args: string[], options: { timeout: number }) => Promise<unknown>;

/**
 * Makes the slate, once, when the transcoder starts: ffmpeg encodes the picture into a loop of
 * segments in a folder of its own. Rejects when ffmpeg fails or writes no segment.
 */
export async function makeSlate(settings: SlateSettings, run: RunFfmpeg = promisify(execFile)): Promise<Slate> {
  const directory = join(settings.hlsDir, SLATE_DIRECTORY);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await run(settings.ffmpegPath, slateArgs(settings, directory), { timeout: TIMEOUT_MS });
  const written = parseMediaPlaylist(await readFile(join(directory, "index.m3u8"), "utf8")).segments;
  const segments = written
    .filter(({ uri, duration }) => /^seg_\d{3}\.ts$/.test(uri) && duration > 0)
    .map(({ uri, duration }) => ({ uri: `../${SLATE_NAME}/${uri}`, duration }));
  if (segments.length === 0) {
    throw new Error("ffmpeg wrote no segment of the slate");
  }
  return { directory, segments };
}

/** The file of one of the slate's segments, by the name a playlist gives it. */
export function slateFile(slate: Slate | undefined, file: string): string | undefined {
  const listed = slate?.segments.some(({ uri }) => uri === `../${SLATE_NAME}/${file}`) ?? false;
  return slate !== undefined && listed ? join(slate.directory, file) : undefined;
}
