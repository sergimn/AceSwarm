import { expect, vi } from "vitest";
import {
  readSource,
  type LayoutChange,
  type LayoutMove,
  type Sink,
  type SourceEnd,
  type SourceRequest,
} from "../src/source-reader.ts";
import { concatBytes } from "./ts-fixtures.ts";

/** A sink that keeps what it gets, like an ffmpeg that reads as fast as the data comes. */
export interface RecordingSink extends Sink {
  chunks: Uint8Array[];
  ended: boolean;
  /** What it got after its end, which must be nothing. */
  late: number;
  bytes: () => Uint8Array;
  /** The PID of every packet it got, in order. */
  pids: () => number[];
}

export function recordingSink(): RecordingSink {
  const chunks: Uint8Array[] = [];
  const sink: RecordingSink = {
    chunks,
    ended: false,
    late: 0,
    write: (bytes: Uint8Array): Promise<void> => {
      sink.late += sink.ended ? bytes.length : 0;
      chunks.push(Uint8Array.from(bytes));
      return Promise.resolve();
    },
    end: (): void => {
      sink.ended = true;
    },
    bytes: (): Uint8Array => concatBytes(...chunks),
    pids: (): number[] => {
      const bytes = concatBytes(...chunks);
      const pids: number[] = [];
      for (let at = 0; at + 188 <= bytes.length; at += 188) {
        pids.push((((bytes[at + 1] ?? 0) & 0x1f) << 8) | (bytes[at + 2] ?? 0));
      }
      return pids;
    },
  };
  return sink;
}

/** An engine whose playback URL answers each request with what a test queued, or a stream it feeds by hand. */
export interface FakeEngine {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  requests: { url: string; aborted: () => boolean }[];
  /** The streams it serves, for a test to feed. */
  bodies: ReadableStreamDefaultController<Uint8Array>[];
  /** What it answers the next requests with, instead of a stream. */
  answers: Response[];
  /** Resolves when the reader next asks for more of a stream and has to wait: it is done with all it got. */
  nextWait: () => Promise<unknown>;
}

export function fakeEngine(): FakeEngine {
  const requests: { url: string; aborted: () => boolean }[] = [];
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const answers: Response[] = [];
  /** Called when the reader next asks for more of a stream and has to wait: it is done with all it got. */
  let wake: (() => void) | undefined;
  const nextWait = (): Promise<unknown> => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    wake = () => {
      resolve(undefined);
    };
    return promise;
  };
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ url, aborted: () => init.signal?.aborted === true });
    const answer = answers.shift();
    if (answer !== undefined) {
      return Promise.resolve(answer);
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          bodies.push(controller);
          init.signal?.addEventListener("abort", () => {
            try {
              controller.error(new Error("aborted"));
            } catch {
              // Already closed.
            }
          });
        },
        pull() {
          wake?.();
          wake = undefined;
        },
      },
      // Nothing is asked for ahead of the reader: `pull` is only called when it waits for more.
      { highWaterMark: 0 },
    );
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "video/mp2t" } }));
  };
  return { fetch, requests, bodies, answers, nextWait };
}

export interface Opened {
  engine: FakeEngine;
  sink: RecordingSink;
  layouts: LayoutChange[];
  /** The changes the sink's run read on over. */
  moves: LayoutMove[];
  ends: SourceEnd[];
  /** The sink `onLayout` hands over next; none keeps the one in use. */
  next: { sink: Sink | undefined };
  clock: { now: number };
  reader: ReturnType<typeof readSource>;
  /** Feeds the stream, and waits until the reader passed it on. */
  feed: (...parts: Uint8Array[]) => Promise<void>;
}

export function open(overrides: Partial<SourceRequest> = {}, engine = fakeEngine()): Opened {
  const sink = recordingSink();
  const layouts: LayoutChange[] = [];
  const moves: LayoutMove[] = [];
  const ends: SourceEnd[] = [];
  const next: Opened["next"] = { sink: undefined };
  const clock = { now: 1_000_000 };
  const request: SourceRequest = {
    source: "http://engine/play",
    idleTimeoutMs: 60_000,
    sink,
    onLayout: (change) => {
      layouts.push(change);
      const handed = next.sink;
      next.sink = undefined;
      return handed;
    },
    onMove: (move) => {
      moves.push(move);
    },
    onEnd: (end) => {
      ends.push(end);
    },
    ...overrides,
  };
  const reader = readSource(request, engine.fetch, () => clock.now);
  const feed = async (...parts: Uint8Array[]): Promise<void> => {
    await vi.waitFor(() => {
      expect(engine.bodies.length).toBeGreaterThan(0);
    });
    // It asks for more once it passed on all of this.
    const done = engine.nextWait();
    engine.bodies.at(-1)?.enqueue(concatBytes(...parts));
    await done;
  };
  return { engine, sink, layouts, moves, ends, next, clock, reader, feed };
}
