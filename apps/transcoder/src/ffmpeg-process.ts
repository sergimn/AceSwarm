import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { lastErrorLine, type Generation } from "./generation.ts";
import { InputBanner, Lines, ProgressParser, type ProgressBlock } from "./progress.ts";
import { NO_SINK, type Sink } from "./source-reader.ts";

const STDERR_TAIL_LINES = 20;

/** What the pipeline does about its ffmpeg runs' output. */
export interface FfmpegHooks {
  now: () => number;
  /** A progress block that counted new frames. */
  onFrames: (block: ProgressBlock) => void;
  /** ffmpeg's banner named the codec of the source's video. */
  onVideoCodec: (codec: string) => void;
  /** Players got the run's first frame after a layout change, after a gap of so many ms (see `Generation.show`). */
  onLayoutGap: (ms: number) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * ffmpeg's standard input as the sink of a source's reader. A write settles once ffmpeg took the
 * bytes or will never take them: an ffmpeg that ended leaves an error on the pipe, which is not
 * news here (its exit is).
 */
export function sinkOf(child: ChildProcess): Sink {
  const stdin = child.stdin as Writable | null | undefined;
  if (stdin === null || stdin === undefined) {
    return NO_SINK;
  }
  let open = true;
  const closed = (): void => {
    open = false;
  };
  stdin.on("error", closed);
  stdin.on("close", closed);
  return {
    write: (bytes) =>
      new Promise<void>((resolve) => {
        if (!open || stdin.write(bytes)) {
          resolve();
          return;
        }
        const settle = (): void => {
          stdin.off("drain", settle);
          stdin.off("close", settle);
          resolve();
        };
        stdin.once("drain", settle);
        stdin.once("close", settle);
      }),
    end: () => {
      if (!open) {
        return;
      }
      open = false;
      stdin.end();
    },
  };
}

/**
 * Makes `child` the generation's ffmpeg: its progress counts the generation's frames, its messages
 * are kept for the error of a run that fails, and its end is the generation's. Once it ended
 * nothing takes the source's data, so the source is not read on either.
 */
export function attachFfmpeg(generation: Generation, child: ChildProcess, hooks: FfmpegHooks): void {
  generation.process = child;
  generation.sink = sinkOf(child);
  const stopReading = (): void => {
    if (generation.connection?.run === generation) {
      generation.connection.reader?.stop();
    }
  };
  const progress = new ProgressParser();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const block of progress.push(chunk)) {
      if (block.frame !== undefined && block.frame > generation.frames) {
        generation.frames = block.frame;
        hooks.onFrames(block);
        generation.lastFrameAt = hooks.now();
        if (generation.state !== "exited") {
          // A block it printed as it ended can be read after its exit: its frames count, but it
          // must not look like it runs again.
          generation.state = "running";
        }
        const gap = generation.publishing() && generation.published ? generation.show() : undefined;
        if (gap !== undefined) {
          hooks.onLayoutGap(gap);
        }
      }
      generation.fps = block.fps;
    }
  });
  const lines = new Lines();
  const banner = new InputBanner();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of lines.push(chunk)) {
      generation.stderrTail.push(line);
      if (generation.stderrTail.length > STDERR_TAIL_LINES) {
        generation.stderrTail.shift();
      }
      const codec = banner.push(line);
      if (codec !== undefined) {
        generation.videoCodec = codec;
        hooks.onVideoCodec(codec);
      }
    }
  });
  child.on("error", (error) => {
    generation.state = "exited";
    generation.error = error.message;
    stopReading();
  });
  child.on("exit", (code, signal) => {
    generation.state = "exited";
    generation.exitCode = code;
    generation.error ??= signal === null ? lastErrorLine(generation.stderrTail, code) : `killed by ${signal}`;
    stopReading();
    hooks.onExit(code, signal);
  });
}
