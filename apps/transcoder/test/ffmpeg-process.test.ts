import type { ChildProcess } from "node:child_process";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { sinkOf } from "../src/ffmpeg-process.ts";
import { NO_SINK } from "../src/source-reader.ts";

/** An ffmpeg whose input takes a chunk only when the test says so, and holds little meanwhile. */
function slowInput(): { child: ChildProcess; taken: Uint8Array[]; take: () => void; stdin: Writable } {
  const taken: Uint8Array[] = [];
  const waiting: (() => void)[] = [];
  const stdin = new Writable({
    highWaterMark: 4,
    write(chunk: Uint8Array, _encoding, done) {
      taken.push(chunk);
      waiting.push(done);
    },
  });
  return {
    child: { stdin } as unknown as ChildProcess,
    taken,
    stdin,
    take: () => {
      waiting.shift()?.();
    },
  };
}

/** Whether a promise has settled by now. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("ffmpeg's input as a reader's sink", () => {
  it("lets a write wait until ffmpeg took what it was given: the engine is read no faster", async () => {
    const { child, taken, take } = slowInput();
    const sink = sinkOf(child);

    // More than the pipe holds: ffmpeg has to take it first.
    const first = sink.write(new Uint8Array(8));
    expect(await settled(first)).toBe(false);
    take();
    expect(await settled(first)).toBe(true);
    expect(taken).toHaveLength(1);

    // What fits is taken on at once.
    const small = sink.write(new Uint8Array(1));
    expect(await settled(small)).toBe(true);
  });

  it("lets a waiting write go when ffmpeg ends, and takes nothing after that", async () => {
    const { child, taken, stdin } = slowInput();
    const sink = sinkOf(child);
    const waiting = sink.write(new Uint8Array(8));
    expect(await settled(waiting)).toBe(false);

    stdin.destroy();

    expect(await settled(waiting)).toBe(true);
    const late = sink.write(new Uint8Array(8));
    expect(await settled(late)).toBe(true);
    expect(taken).toHaveLength(1);
  });

  it("takes an error on the pipe for the end of ffmpeg, not for something to fail over", async () => {
    const { child, taken, stdin } = slowInput();
    const sink = sinkOf(child);

    // Without a listener of the sink's, this would be an uncaught error.
    stdin.destroy(new Error("write EPIPE"));

    const late = sink.write(new Uint8Array(8));
    expect(await settled(late)).toBe(true);
    expect(taken).toHaveLength(0);
    sink.end();
  });

  it("ends ffmpeg's input once", () => {
    const { child, stdin } = slowInput();
    const sink = sinkOf(child);
    sink.end();
    expect(stdin.writableEnded).toBe(true);
    // A second end, or a write after it, is nothing to an input that has ended.
    sink.end();
  });

  it("takes nothing for an ffmpeg without an input", () => {
    expect(sinkOf({ stdin: null } as unknown as ChildProcess)).toBe(NO_SINK);
  });
});
