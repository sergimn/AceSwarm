/**
 * Runs the real ffmpeg of the transcoder image on a broadcast that stops sending key frames, fed at
 * a pace like a live engine. ffmpeg's HLS muxer holds the segment it writes in memory until it can
 * start the next one, and a copied video can only start one at a key frame as ffmpeg sees it, so
 * the full output stops while the preview and ffmpeg's frame count go on (see "A full output that
 * stops" in docs/architecture.md). The pipeline has to notice that by itself (see `StuckRuns`).
 *
 * Like `ffmpeg-gaps.test.ts`, it only runs with `FFMPEG_BIN` set to the ffmpeg 9.0.2 binary of the
 * transcoder image (the CI job "ffmpeg with timestamp gaps" runs both):
 *
 *   docker create docker.io/mwader/static-ffmpeg:9.0.2   # then docker cp <container>:/ffmpeg .
 *   FFMPEG_BIN=$PWD/ffmpeg npx vitest run apps/transcoder/test/ffmpeg-full-stall.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@aceswarm/shared/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFfmpegArgs, type FfmpegPlan } from "../src/ffmpeg-args.ts";
import { Pipeline } from "../src/pipeline.ts";
import { parseMediaPlaylist } from "../src/playlist.ts";

const FFMPEG = process.env["FFMPEG_BIN"];
const PACKET = 188;
/** The sample's stream seconds with key frames, then without. */
const WITH_KEY_FRAMES = 12;
const WITHOUT_KEY_FRAMES = 120;
/** How many times faster than its own pace the sample is fed: a live engine sends it at 1. */
const PACE = 4;

const PLAN_SETTINGS = {
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
} as const;

/** The stream seconds a media playlist's segments end at, from ffmpeg's own playlist. */
function playlistEnd(path: string): number {
  const text = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  })();
  const { mediaSequence, segments } = parseMediaPlaylist(text);
  // Every segment before the listed ones was as long as the target duration (2 s) or so.
  return mediaSequence * 2 + segments.reduce((total, segment) => total + segment.duration, 0);
}

function ffmpeg(args: string[]): void {
  execFileSync(FFMPEG ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

describe.skipIf(FFMPEG === undefined)("ffmpeg with a broadcast that stops sending key frames", () => {
  let directory: string;
  let sample: Buffer;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "aceswarm-full-stall-"));
    const lavfi = (seconds: number): string[] => [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=480x270:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      String(seconds),
    ];
    const audio = ["-c:a", "aac", "-b:a", "128k"];
    const first = join(directory, "first.ts");
    const openGop = join(directory, "open-gop.ts");
    const second = join(directory, "second.ts");
    ffmpeg([...lavfi(WITH_KEY_FRAMES), "-c:v", "libx264", "-preset", "veryfast", "-g", "50", ...audio, first]);
    // Then I frames every 2 s that are no key frames to ffmpeg: an open GOP whose I frames have
    // no recovery point (x264 writes one, so it is taken out), with several reference frames.
    ffmpeg([
      ...lavfi(WITHOUT_KEY_FRAMES),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-x264-params",
      "open-gop=1:keyint=50:min-keyint=50:scenecut=0",
      ...audio,
      "-output_ts_offset",
      String(WITH_KEY_FRAMES),
      openGop,
    ]);
    ffmpeg(["-i", openGop, "-map", "0", "-c", "copy", "-bsf:v", "filter_units=remove_types=6", "-f", "mpegts", second]);
    sample = Buffer.concat([readFileSync(first), readFileSync(second)]);
    writeFileSync(join(directory, "sample.ts"), sample);
  }, 120_000);

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const bytesPerSecond = (): number => (sample.length / (WITH_KEY_FRAMES + WITHOUT_KEY_FRAMES)) * PACE;

  it("stops the full output while the preview and the frame count go on", async () => {
    const output = join(directory, "plain");
    mkdirSync(join(output, "full"), { recursive: true });
    mkdirSync(join(output, "preview"), { recursive: true });
    const plan: FfmpegPlan = { ...PLAN_SETTINGS, source: "pipe:0", directory: output, fullMode: "copy" };
    const child = spawn(FFMPEG ?? "ffmpeg", buildFfmpegArgs(plan), { stdio: ["pipe", "pipe", "ignore"] });
    let frames = 0;
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      const frame = /frame=(\d+)/.exec(text)?.[1];
      frames = frame === undefined ? frames : Number(frame);
    });
    child.stdin.on("error", () => undefined);
    const exited = once(child, "exit");
    // Feeds all but the last few seconds, and looks at the outputs while ffmpeg still runs.
    const chunk = Math.round(bytesPerSecond() / 50);
    const until = sample.length - Math.round(bytesPerSecond() * 2);
    for (let at = 0; at < until; at += chunk) {
      child.stdin.write(sample.subarray(at, Math.min(at + chunk, until)));
      await sleep(20);
    }
    await sleep(2000);
    const full = playlistEnd(join(output, "full", "index.m3u8"));
    const preview = playlistEnd(join(output, "preview", "index.m3u8"));
    const framesThen = frames;
    child.stdin.end(sample.subarray(until));
    await exited;

    // The full output's last segment ends where the key frames stopped, though ffmpeg read on.
    expect(full).toBeGreaterThan(WITH_KEY_FRAMES - 4);
    expect(full).toBeLessThanOrEqual(WITH_KEY_FRAMES + 2);
    // It holds the last 2 s back (8 s of the stream at this pace), and lags a few seconds.
    expect(preview).toBeGreaterThan(WITH_KEY_FRAMES + WITHOUT_KEY_FRAMES - 16);
    // ffmpeg counts the frames it hands the full output's muxer, so its count goes on.
    expect(framesThen).toBeGreaterThan((WITH_KEY_FRAMES + WITHOUT_KEY_FRAMES - 16) * 25);
    // All that it held is written out as one segment as ffmpeg ends.
    const last = parseMediaPlaylist(readFileSync(join(output, "full", "index.m3u8"), "utf8")).segments.at(-1);
    expect(last?.duration).toBeGreaterThan(WITHOUT_KEY_FRAMES - 4);
  }, 90_000);

  describe("in a pipeline", () => {
    let server: Server;
    let url: string;

    beforeAll(async () => {
      // An engine of a live broadcast: every connection gets the stream from where it is now.
      const startedAt = Date.now();
      server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "video/mp2t" });
        const elapsed = (Date.now() - startedAt) / 1000;
        let at = Math.floor((elapsed * bytesPerSecond()) / PACKET) * PACKET;
        const timer = setInterval(() => {
          const next = Math.min(sample.length, at + Math.round(bytesPerSecond() / 50));
          response.write(sample.subarray(at, next));
          at = next;
          if (at < sample.length) {
            return;
          }
          clearInterval(timer);
          response.end();
        }, 20);
        request.on("close", () => {
          clearInterval(timer);
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/play`;
    });

    afterAll(() => {
      server.closeAllConnections();
      server.close();
    });

    it("starts ffmpeg again once the full output wrote nothing for the stall time, then re-encodes it", async () => {
      const started: { reason: string; at: number }[] = [];
      const begin = Date.now();
      const pipeline = new Pipeline(
        "stall",
        {
          hlsDir: join(directory, "hls"),
          ffmpegPath: FFMPEG ?? "ffmpeg",
          handoverTimeoutMs: 120_000,
          plan: PLAN_SETTINGS,
          stuck: { fullOutputStallMs: 8000, maxMemoryBytes: 1024 * 1024 * 1024 },
        },
        createLogger("test", "silent"),
        {
          generationStarted: (_id, reason) => {
            started.push({ reason, at: (Date.now() - begin) / 1000 });
          },
          handover: () => undefined,
        },
      );
      try {
        await pipeline.start(url, false);
        const keyFramesStop = WITH_KEY_FRAMES / PACE;
        for (let waited = 0; waited < 30 && started.length < 2; waited += 0.5) {
          await sleep(500);
        }
        expect(started.map((start) => start.reason)).toEqual(["start", "full-output-stalled"]);
        // Not before the stall time had passed since the key frames stopped, nor much after.
        expect(started[1]?.at).toBeGreaterThan(keyFramesStop + 8 - 2);
        expect(started[1]?.at).toBeLessThan(keyFramesStop + 8 + 6);
        const first = join(directory, "hls", "stall", "g1");
        expect(playlistEnd(join(first, "full", "index.m3u8"))).toBeLessThanOrEqual(WITH_KEY_FRAMES + 2);
        expect(playlistEnd(join(first, "preview", "index.m3u8"))).toBeGreaterThan(WITH_KEY_FRAMES + 8 * PACE - 8);
        expect(pipeline.status().mode).toBe("copy");

        // The new run's copy gets no frame at all, as no key frame comes: the full stream is
        // re-encoded after the stall time, and plays.
        for (let waited = 0; waited < 25 && started.length < 3; waited += 0.5) {
          await sleep(500);
        }
        expect(started.map((start) => start.reason)).toEqual(["start", "full-output-stalled", "full-output-stalled"]);
        expect(pipeline.status().mode).toBe("transcode");
        const third = join(directory, "hls", "stall", "g3", "full", "index.m3u8");
        for (let waited = 0; waited < 10 && playlistEnd(third) < 4; waited += 0.5) {
          await sleep(500);
        }
        expect(playlistEnd(third)).toBeGreaterThanOrEqual(4);
        expect(playlistEnd(join(directory, "hls", "stall", "g2", "full", "index.m3u8"))).toBe(0);
      } finally {
        await pipeline.stop();
      }
    }, 90_000);
  });
});
