import { spawn, type ChildProcess } from "node:child_process";
import { ProgressParser } from "./progress.ts";

export interface DecodeCheckSettings {
  ffmpegPath: string;
  /** A standby whose video decoded is checked again after this long. */
  intervalMs: number;
  /** A standby whose video didn't decode is checked again after this long. */
  retryMs: number;
  /** A check passes once ffmpeg decoded this many video frames... */
  minFrames: number;
  /** ...within this long. It fails otherwise: enough for a few keyframes, which can be seconds apart. */
  timeoutMs: number;
  /** Checks that run at once, across every stream's standbys. */
  maxRunning: number;
}

export const DEFAULT_DECODE_CHECK_SETTINGS: DecodeCheckSettings = {
  ffmpegPath: "ffmpeg",
  intervalMs: 60_000,
  retryMs: 10_000,
  minFrames: 5,
  timeoutMs: 20_000,
  maxRunning: 1,
};

/** One check: ffmpeg decodes what it is fed, and `result` says whether video came out. */
export interface DecodeCheck {
  feed: (chunk: Uint8Array) => void;
  readonly result: Promise<boolean>;
  stop: () => void;
}

/** Starts checks, at most `maxRunning` at once. */
export interface DecodeChecker {
  readonly settings: DecodeCheckSettings;
  /** A new check, or undefined while as many run as allowed. */
  start: () => DecodeCheck | undefined;
}

export type DecodeSpawner = (command: string, args: string[]) => ChildProcess;

const defaultSpawner: DecodeSpawner = (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });

/** Data that waits for ffmpeg past this is dropped: a check only needs a few seconds of video. */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/** ffmpeg reads MPEG-TS from stdin, decodes the first video stream and throws the frames away. */
export function decodeCheckArgs(): string[] {
  return [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-stats_period",
    "0.5",
    "-probesize",
    "1000000",
    "-analyzeduration",
    "3000000",
    "-f",
    "mpegts",
    "-i",
    "pipe:0",
    "-map",
    "0:v:0",
    "-f",
    "null",
    "-progress",
    "pipe:1",
    "-",
  ];
}

/**
 * Checks that a standby's data holds video that ffmpeg can decode, the way it would after a
 * failover, without opening the engine's session a second time (an engine allows one reader per
 * session): the standby's reader feeds the check the data it reads anyway.
 */
export function createDecodeChecker(
  settings: DecodeCheckSettings = DEFAULT_DECODE_CHECK_SETTINGS,
  spawner: DecodeSpawner = defaultSpawner,
): DecodeChecker {
  let running = 0;
  return {
    settings,
    start: () => {
      if (running >= settings.maxRunning) {
        return undefined;
      }
      running += 1;
      const check = runCheck(settings, spawner);
      void check.result.finally(() => {
        running -= 1;
      });
      return check;
    },
  };
}

function runCheck(settings: DecodeCheckSettings, spawner: DecodeSpawner): DecodeCheck {
  const { promise: result, resolve: settle } = Promise.withResolvers<boolean>();
  let child: ChildProcess | undefined;
  let done = false;
  const finish = (decoded: boolean): void => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    child?.stdin?.destroy();
    child?.kill("SIGKILL");
    settle(decoded);
  };
  const timer = setTimeout(() => {
    finish(false);
  }, settings.timeoutMs);
  timer.unref();

  try {
    child = spawner(settings.ffmpegPath, decodeCheckArgs());
  } catch {
    finish(false);
  }
  const progress = new ProgressParser();
  child?.stdout?.setEncoding("utf8");
  child?.stdout?.on("data", (chunk: string) => {
    for (const block of progress.push(chunk)) {
      if (block.frame !== undefined && block.frame >= settings.minFrames) {
        finish(true);
      }
    }
  });
  // ffmpeg that exits or can't start, or stdin that breaks, ends the check without video.
  child?.on("error", () => {
    finish(false);
  });
  child?.on("exit", () => {
    finish(false);
  });
  child?.stdin?.on("error", () => {
    finish(false);
  });

  return {
    result,
    feed: (chunk) => {
      const stdin = child?.stdin;
      if (!done && stdin?.writable === true && stdin.writableLength < MAX_QUEUED_BYTES) {
        stdin.write(chunk);
      }
    },
    stop: () => {
      finish(false);
    },
  };
}
