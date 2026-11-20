/**
 * Runs the real ffmpeg of the transcoder image on a stream with gaps in its video timestamps, fed at
 * a pace like a live engine. Unit tests with a fake ffmpeg cannot see what this checks: ffmpeg 9 can
 * stop for good when a filter graph of the preview repeats a frame (see "ffmpeg and gaps in the
 * video's timestamps" in docs/architecture.md), and only when its input comes at a pace; a file read
 * at full speed passes.
 *
 * It only runs with `FFMPEG_BIN` set to the ffmpeg 9.0.2 binary of the transcoder image (the CI job
 * "ffmpeg with timestamp gaps" takes it out of the image the Dockerfile names):
 *
 *   docker create docker.io/mwader/static-ffmpeg:9.0.2   # then docker cp <container>:/ffmpeg .
 *   FFMPEG_BIN=$PWD/ffmpeg npx vitest run apps/transcoder/test/ffmpeg-gaps.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFfmpegArgs, type FfmpegPlan } from "../src/ffmpeg-args.ts";

const FFMPEG = process.env["FFMPEG_BIN"];

const PACKET = 188;
const VIDEO_PID = 0x1_00;
const AUDIO_PID = 0x1_01;
/** What the sample's bytes per second are (about 177 kB/s), five times over: live pace is slower. */
const BYTES_PER_SECOND = 885_000;
/** A write that ffmpeg does not take for this long means it stopped reading. */
const STUCK_MS = 6000;
const EXIT_MS = 15_000;

interface Outcome {
  stuck: boolean;
  exitCode: number | null;
  stderr: string;
}

/** The PTS (seconds) of the PES packet that starts in this transport packet, if it has one. */
function startPts(packet: Buffer): number | undefined {
  if ((packet[1] ?? 0) & 0x40) {
    const adaptation = (packet[3] ?? 0) & 0x20 ? 1 + (packet[4] ?? 0) : 0;
    const pes = 4 + adaptation;
    if (
      pes + 14 <= PACKET &&
      packet[pes] === 0 &&
      packet[pes + 1] === 0 &&
      packet[pes + 2] === 1 &&
      ((packet[pes + 7] ?? 0) & 0x80) !== 0
    ) {
      const at = pes + 9;
      const byte = (offset: number): number => packet[at + offset] ?? 0;
      const ticks =
        ((byte(0) >> 1) & 7) * 2 ** 30 + (byte(1) << 22) + ((byte(2) >> 1) << 15) + (byte(3) << 7) + (byte(4) >> 1);
      return ticks / 90_000;
    }
  }
  return undefined;
}

function pidOf(packet: Buffer): number {
  return (((packet[1] ?? 0) & 0x1f) << 8) | (packet[2] ?? 0);
}

/** Leaves out the video frame that starts at the first video PES at or after `seconds`. */
function dropFrame(stream: Buffer, seconds: number): Buffer {
  const kept: Buffer[] = [];
  let first: number | undefined;
  let dropping = false;
  let dropped = false;
  for (let at = 0; at + PACKET <= stream.length; at += PACKET) {
    const packet = stream.subarray(at, at + PACKET);
    if (pidOf(packet) === VIDEO_PID) {
      const pts = startPts(packet);
      if (pts !== undefined) {
        first ??= pts;
        dropping = false;
        if (!dropped && pts - first >= seconds) {
          dropping = true;
          dropped = true;
        }
      }
      if (dropping) {
        continue;
      }
    }
    kept.push(packet);
  }
  expect(dropped, `a frame at ${String(seconds)} s`).toBe(true);
  return Buffer.concat(kept);
}

/** Leaves out every video and audio packet between two stream times: a lost stretch of a P2P stream. */
function dropSpan(stream: Buffer, from: number, to: number): Buffer {
  const kept: Buffer[] = [];
  let first: number | undefined;
  let now = 0;
  let dropped = 0;
  for (let at = 0; at + PACKET <= stream.length; at += PACKET) {
    const packet = stream.subarray(at, at + PACKET);
    const pid = pidOf(packet);
    if (pid === VIDEO_PID) {
      const pts = startPts(packet);
      if (pts !== undefined) {
        first ??= pts;
        now = pts - first;
      }
    }
    if (now >= from && now < to && (pid === VIDEO_PID || pid === AUDIO_PID)) {
      dropped += 1;
      continue;
    }
    kept.push(packet);
  }
  expect(dropped, `packets between ${String(from)} and ${String(to)} s`).toBeGreaterThan(0);
  return Buffer.concat(kept);
}

/** Feeds the stream to ffmpeg's stdin at a pace and says whether ffmpeg stopped taking it. */
async function feed(args: string[], stream: Buffer): Promise<Outcome> {
  const child = spawn(FFMPEG ?? "ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  child.stdin.on("error", () => undefined);
  const exited = once(child, "exit");
  const chunk = Math.round(BYTES_PER_SECOND * 0.017);
  let stuck = false;
  for (let at = 0; at < stream.length && !stuck; at += chunk) {
    if (!child.stdin.write(stream.subarray(at, at + chunk))) {
      const drained = await Promise.race([
        once(child.stdin, "drain").then(() => true),
        sleep(STUCK_MS).then(() => false),
      ]);
      stuck = !drained;
    }
    await sleep(17);
  }
  if (!stuck) {
    child.stdin.end();
    stuck = !(await Promise.race([exited.then(() => true), sleep(EXIT_MS).then(() => false)]));
  }
  const exitCode = stuck ? null : child.exitCode;
  if (stuck) {
    child.kill("SIGKILL");
    await exited;
  }
  return { stuck, exitCode, stderr };
}

/** The arguments as they were before the fix: the preview repeats frames with the `fps` filter. */
function withFpsFilter(args: string[]): string[] {
  const select = args.findIndex((arg) => arg.startsWith("select="));
  expect(select).toBeGreaterThan(0);
  const frameRate = args.indexOf("-r", select);
  const replaced = [...args];
  replaced[select] = "fps=15,scale=-2:270";
  // Drops "-r 15 -fps_mode cfr".
  replaced.splice(frameRate, 4);
  return replaced;
}

describe.skipIf(FFMPEG === undefined)("ffmpeg with gaps in the video's timestamps", () => {
  let directory: string;
  let sample: Buffer;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "aceswarm-gaps-"));
    const file = join(directory, "sample.ts");
    // 26 s of 25 fps video without B-frames, with audio: a race inside ffmpeg never showed in the
    // first 10 s of a run, so the gaps come later.
    execFileSync(FFMPEG ?? "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=480x270:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "26",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-bf",
      "0",
      "-g",
      "25",
      "-b:v",
      "1200k",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "mpegts",
      file,
    ]);
    sample = readFileSync(file);
  }, 60_000);

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function plan(fullMode: FfmpegPlan["fullMode"], name: string): FfmpegPlan {
    const output = join(directory, name);
    mkdirSync(join(output, "full"), { recursive: true });
    mkdirSync(join(output, "preview"), { recursive: true });
    return {
      source: "pipe:0",
      directory: output,
      fullMode,
      previewMode: "video",
      previewHeight: 270,
      previewFps: 15,
      previewBitrateKbps: 400,
      fullTranscodeMaxHeight: 1080,
      audioBitrateKbps: 128,
      segmentSeconds: 2,
      playlistSize: 6,
      thumbnailIntervalSeconds: 10,
      inputTimeoutSeconds: 60,
    };
  }

  const gaps: Record<string, () => Buffer> = {
    "a video frame missing at 10 s": () => dropFrame(sample, 10),
    "a video frame missing at 15 s": () => dropFrame(sample, 15),
    "a stretch of 2 s missing at 7 s": () => dropSpan(sample, 7, 9),
    "half a second missing at 12 s": () => dropSpan(sample, 12, 12.5),
  };

  // On the arguments from before the fix, only a single missing frame with a re-encoded full stream
  // froze on every run. The other cases passed then (a copied full stream froze with an older
  // thumbnail filter) and stay as cover, so the arguments can change without the race coming back.
  for (const fullMode of ["copy", "transcode"] as const) {
    for (const [name, make] of Object.entries(gaps)) {
      it(`goes on and exits when the full stream is ${fullMode === "copy" ? "copied" : "re-encoded"} and ${name}`, async () => {
        const args = buildFfmpegArgs(plan(fullMode, `${fullMode}-${name.replaceAll(" ", "-")}`));
        const outcome = await feed(args, make());
        expect(outcome.stuck, outcome.stderr.slice(-2000)).toBe(false);
        expect(outcome.exitCode, outcome.stderr.slice(-2000)).toBe(0);
        // The previews and the thumbnail came out of the same run.
        const output = args.at(-1) ?? "";
        expect(existsSync(output)).toBe(true);
        const segments = readdirSync(join(output, "..", "preview")).filter((file) => file.endsWith(".ts"));
        expect(segments.length).toBeGreaterThan(2);
      }, 60_000);
    }
  }

  it("still freezes with the fps filter in the preview, which is why the preview uses select", async () => {
    // This is the control of the tests above: it shows that the way they feed ffmpeg can see the
    // freeze. When this fails on a newer ffmpeg, that build has the scheduler fixed, and the
    // workaround in ffmpeg-args.ts (and these tests) can go.
    let frozen = 0;
    const log: string[] = [];
    // A missing frame with a re-encoded full stream froze every run; a missing stretch did not.
    const frameGaps = Object.entries(gaps).filter(([gap]) => gap.includes("frame"));
    for (const [name, make] of frameGaps) {
      const reencoded = buildFfmpegArgs(plan("transcode", `control-${name.replaceAll(" ", "-")}`));
      const outcome = await feed(withFpsFilter(reencoded), make());
      log.push(`${name}: ${outcome.stuck ? "frozen" : `exit ${String(outcome.exitCode)}`}`);
      if (outcome.stuck) {
        frozen += 1;
      }
    }
    expect(frozen, log.join("; ")).toBeGreaterThan(0);
  }, 120_000);
});
