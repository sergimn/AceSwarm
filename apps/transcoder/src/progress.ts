/** One block of `ffmpeg -progress` output (key=value lines ending with `progress=...`). */
export interface ProgressBlock {
  frame: number | undefined;
  fps: number | undefined;
  progress: string | undefined;
}

/**
 * Incremental parser for `ffmpeg -progress pipe:1`. Feed it raw chunks; it returns every
 * complete block found so far.
 */
export class ProgressParser {
  private buffer = "";
  private current: Record<string, string> = {};

  push(chunk: string): ProgressBlock[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const blocks: ProgressBlock[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      const separator = line.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = line.slice(0, separator);
      this.current[key] = line.slice(separator + 1);
      if (key !== "progress") {
        continue;
      }
      blocks.push(toBlock(this.current));
      this.current = {};
    }
    return blocks;
  }
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBlock(values: Record<string, string>): ProgressBlock {
  return {
    frame: toNumber(values["frame"]),
    fps: toNumber(values["fps"]),
    progress: values["progress"],
  };
}

/** Extracts the codec of a video stream from the line of ffmpeg's banner that lists it. */
export function parseInputVideoCodec(stderrLine: string): string | undefined {
  const match = /^\s*Stream #0:\d+.*?: Video: ([\w-]+)/.exec(stderrLine);
  return match?.[1];
}

/**
 * Splits what a process writes into lines. Its output comes in chunks of any size, so a line can
 * come in two of them: the part without its end waits for the rest.
 */
export class Lines {
  private rest = "";

  /** Feeds the next chunk, and returns the lines it completed, trimmed, without the empty ones. */
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split(/[\r\n]/);
    this.rest = parts.pop() ?? "";
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }
}

/**
 * Finds the codec of the source's video in ffmpeg's banner, fed line by line. ffmpeg lists its
 * input's streams first and its outputs' later, in the same words (`Stream #0:0: Video: h264` is
 * also the full output of a run that re-encodes), so only the lines before its stream mapping
 * count, and only the first video stream.
 */
export class InputBanner {
  private done = false;

  /** The codec, when `line` is the one that names it; undefined for any other line. */
  push(line: string): string | undefined {
    if (this.done) {
      return undefined;
    }
    if (/^(Stream mapping:|Output #)/.test(line)) {
      this.done = true;
      return undefined;
    }
    const codec = parseInputVideoCodec(line);
    this.done = codec !== undefined;
    return codec;
  }
}
