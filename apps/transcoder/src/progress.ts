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

/** Extracts the codec of the first input video stream from ffmpeg's stderr banner. */
export function parseInputVideoCodec(stderrLine: string): string | undefined {
  const match = /^\s*Stream #0:\d+.*?: Video: ([\w-]+)/.exec(stderrLine);
  return match?.[1];
}
