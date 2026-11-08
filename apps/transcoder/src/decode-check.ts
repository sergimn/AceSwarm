import { spawn, type ChildProcess } from "node:child_process";
import { ProgressParser } from "./progress.ts";

export interface DecodeCheckSettings {
  ffmpegPath: string;
  /** A standby whose video decoded is checked again after this long. */
  intervalMs: number;
  /**
   * A standby whose video didn't decode, or whose check said nothing, is checked again after this
   * long, doubling up to `maxRetryMs` while that goes on.
   */
  retryMs: number;
  maxRetryMs: number;
  /** A check passes once ffmpeg decoded this many video frames... */
  minFrames: number;
  /** ...within this long. It fails otherwise: enough for a few keyframes, which can be seconds apart. */
  timeoutMs: number;
  /** A check that got no data for this long says nothing: the standby's connection went quiet. */
  quietMs: number;
  /** Checks that run at once, across every stream's standbys. */
  maxRunning: number;
}

export const DEFAULT_DECODE_CHECK_SETTINGS: DecodeCheckSettings = {
  ffmpegPath: "ffmpeg",
  intervalMs: 60_000,
  retryMs: 10_000,
  maxRetryMs: 300_000,
  minFrames: 5,
  timeoutMs: 20_000,
  quietMs: 5000,
  maxRunning: 2,
};

/**
 * How a check ended: ffmpeg decoded video, it didn't (no frames in time, or it gave up on the
 * data), or the check says nothing (stopped, its data stopped coming, or ffmpeg couldn't start).
 */
export type DecodeResult = "decoded" | "no-video" | "inconclusive";

/** One check: ffmpeg decodes what it is fed, and `result` says whether video came out. */
export interface DecodeCheck {
  feed: (chunk: Uint8Array) => void;
  readonly result: Promise<DecodeResult>;
  /** Ends the check at once, as inconclusive. */
  stop: () => void;
}

/**
 * How soon a standby needs a check: one whose last check failed doesn't count as hot until one
 * passes, one never checked counts until one fails, and a routine re-check can wait.
 */
export const CHECK_PRIORITY = { routine: 0, first: 1, afterFailure: 2 } as const;
export type CheckPriority = (typeof CHECK_PRIORITY)[keyof typeof CHECK_PRIORITY];

/**
 * Hands out checks, at most `maxRunning` at once. Higher priorities go first, and among the same
 * priority who waits longest.
 */
export interface DecodeChecker {
  readonly settings: DecodeCheckSettings;
  /**
   * A check for `who` if it is its turn and one is free; otherwise it waits in line (asking again
   * keeps its place) and gets undefined.
   */
  start: (who: object, priority: CheckPriority) => DecodeCheck | undefined;
  /** Leaves the line: the reader closed, or its data stopped coming. */
  cancel: (who: object) => void;
}

export type DecodeSpawner = (command: string, args: string[]) => ChildProcess;

export interface DecodeCheckerOptions {
  spawner?: DecodeSpawner;
  now?: () => number;
  /** Called the first time ffmpeg can't start: no check says anything until it can. */
  onCannotStart?: (error: unknown) => void;
}

const defaultSpawner: DecodeSpawner = (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });

/**
 * Data that waits for ffmpeg past this is dropped: a check only needs a few seconds of video. An
 * ffmpeg that stops reading so gets nothing more, and its check ends as inconclusive once quiet.
 */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
/** A reader that didn't ask again for this long lost its place: its data stopped coming. */
const LINE_TIMEOUT_MS = 5000;

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

interface Waiting {
  who: object;
  priority: CheckPriority;
  /** Its place in line. */
  since: number;
  /** When it last asked. */
  askedAt: number;
}

/**
 * Checks that a standby's data holds video that ffmpeg can decode, the way it would after a
 * failover, without opening the engine's session a second time (an engine allows one reader per
 * session): the standby's reader feeds the check the data it reads anyway.
 */
export function createDecodeChecker(
  settings: DecodeCheckSettings = DEFAULT_DECODE_CHECK_SETTINGS,
  options: DecodeCheckerOptions = {},
): DecodeChecker {
  const { spawner = defaultSpawner, now = Date.now } = options;
  let running = 0;
  let order = 0;
  const line = new Map<object, Waiting>();
  let warned = false;
  const cannotStart = (error: unknown): void => {
    if (warned) {
      return;
    }
    warned = true;
    options.onCannotStart?.(error);
  };

  /** Who goes next among those still asking. */
  function next(): Waiting | undefined {
    const gone = line
      .values()
      .filter((waiting) => now() - waiting.askedAt > LINE_TIMEOUT_MS)
      .toArray();
    for (const waiting of gone) {
      line.delete(waiting.who);
    }
    let best: Waiting | undefined;
    for (const waiting of line.values()) {
      if (
        best === undefined ||
        waiting.priority > best.priority ||
        (waiting.priority === best.priority && waiting.since < best.since)
      ) {
        best = waiting;
      }
    }
    return best;
  }

  return {
    settings,
    start: (who, priority) => {
      const waiting = line.get(who);
      if (waiting === undefined) {
        line.set(who, { who, priority, since: order++, askedAt: now() });
      } else {
        waiting.priority = priority;
        waiting.askedAt = now();
      }
      if (running >= settings.maxRunning || next()?.who !== who) {
        return undefined;
      }
      line.delete(who);
      running += 1;
      const check = runCheck(settings, { spawner, now, cannotStart });
      void check.result.finally(() => {
        running -= 1;
      });
      return check;
    },
    cancel: (who) => {
      line.delete(who);
    },
  };
}

interface RunDeps {
  spawner: DecodeSpawner;
  now: () => number;
  cannotStart: (error: unknown) => void;
}

function runCheck(settings: DecodeCheckSettings, deps: RunDeps): DecodeCheck {
  const { spawner, now, cannotStart } = deps;
  const { promise: result, resolve: settle } = Promise.withResolvers<DecodeResult>();
  let child: ChildProcess | undefined;
  let done = false;
  let fedAt = now();
  const finish = (outcome: DecodeResult): void => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    clearInterval(quiet);
    child?.stdin?.destroy();
    child?.kill("SIGKILL");
    settle(outcome);
  };
  const timer = setTimeout(() => {
    finish("no-video");
  }, settings.timeoutMs);
  timer.unref();
  const quiet = setInterval(
    () => {
      if (now() - fedAt > settings.quietMs) {
        finish("inconclusive");
      }
    },
    Math.min(1000, settings.quietMs),
  );
  quiet.unref();

  try {
    child = spawner(settings.ffmpegPath, decodeCheckArgs());
  } catch (error) {
    cannotStart(error);
    finish("inconclusive");
  }
  const progress = new ProgressParser();
  child?.stdout?.setEncoding("utf8");
  child?.stdout?.on("data", (chunk: string) => {
    for (const block of progress.push(chunk)) {
      if (block.frame !== undefined && block.frame >= settings.minFrames) {
        finish("decoded");
      }
    }
  });
  // ffmpeg that can't start says nothing about the video; one that gives up on the data found
  // none it could decode (no video stream, or nothing it could read).
  child?.on("error", (error) => {
    cannotStart(error);
    finish("inconclusive");
  });
  child?.on("exit", () => {
    finish("no-video");
  });
  child?.stdin?.on("error", () => {
    finish("no-video");
  });

  return {
    result,
    feed: (chunk) => {
      const stdin = child?.stdin;
      if (done || stdin?.writable !== true || stdin.writableLength >= MAX_QUEUED_BYTES) {
        return;
      }
      fedAt = now();
      stdin.write(chunk);
    },
    stop: () => {
      finish("inconclusive");
    },
  };
}
