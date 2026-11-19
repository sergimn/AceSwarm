import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { readSource, type LayoutChange, type Sink, type SourceEnd, type SourceRequest } from "../src/source-reader.ts";
import { describeLayout } from "../src/ts-tables.ts";
import { concatBytes, noise, NULL_PID, tablePackets, tsPackets, type TableStream } from "./ts-fixtures.ts";

const H264: TableStream[] = [
  { pid: 256, type: 0x1b },
  { pid: 257, type: 0x0f },
];
const MOVED: TableStream[] = [
  { pid: 211, type: 0x1b },
  { pid: 221, type: 0x0f },
];
const HEVC: TableStream[] = [
  { pid: 211, type: 0x24 },
  { pid: 221, type: 0x0f },
];

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** What an engine answers while it has no video to serve yet. */
const notReady = (): Response => new Response("failed to seek", { headers: { "content-type": "text/plain" } });

/** A sink that keeps what it gets, like an ffmpeg that reads as fast as the data comes. */
function recordingSink() {
  const chunks: Uint8Array[] = [];
  const sink = {
    chunks,
    ended: false,
    /** What it got after its end, which must be nothing. */
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
    /** The PID of every packet it got, in order. */
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
function fakeEngine() {
  const requests: { url: string; aborted: () => boolean }[] = [];
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const answers: Response[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ url, aborted: () => init.signal?.aborted === true });
    const answer = answers.shift();
    if (answer !== undefined) {
      return Promise.resolve(answer);
    }
    const body = new ReadableStream<Uint8Array>({
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
    });
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "video/mp2t" } }));
  };
  return { fetch, requests, bodies, answers };
}

interface Opened {
  engine: ReturnType<typeof fakeEngine>;
  sink: ReturnType<typeof recordingSink>;
  layouts: LayoutChange[];
  ends: SourceEnd[];
  /** The sink `onLayout` hands over next; none keeps the one in use. */
  next: { sink: Sink | undefined };
  clock: { now: number };
  reader: ReturnType<typeof readSource>;
  /** Feeds the stream, and waits until the reader passed it on. */
  feed: (...parts: Uint8Array[]) => Promise<void>;
}

function open(overrides: Partial<SourceRequest> = {}, engine = fakeEngine()): Opened {
  const sink = recordingSink();
  const layouts: LayoutChange[] = [];
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
    const before = reader.status().bytes;
    const bytes = concatBytes(...parts);
    engine.bodies.at(-1)?.enqueue(bytes);
    await vi.waitFor(() => {
      expect(reader.status().bytes).toBe(before + bytes.length);
    });
    // The reader passes a chunk on in the turns after it counted it.
    await sleep(5);
  };
  return { engine, sink, layouts, ends, next, clock, reader, feed };
}

describe("readSource", () => {
  it("holds the stream back until its tables came, and passes it on with the tables first", async () => {
    const { sink, layouts, reader, feed } = open();
    await feed(tsPackets(20, 256));
    expect(sink.chunks).toEqual([]);
    expect(layouts).toEqual([]);

    await feed(tablePackets(H264), tsPackets(10, 256));
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ previous: undefined, delivered: false });
    expect(describeLayout(reader.status().layout ?? { programs: [], key: "" })).toBe("program 1 [256:h264 257:0x0f]");
    // The tables, what came before them, then the stream as it is (its own tables included).
    expect(sink.pids()).toEqual([
      0,
      0x10_00,
      ...Array.from({ length: 20 }, () => 256),
      0,
      0x10_00,
      ...Array.from({ length: 10 }, () => 256),
    ]);
    expect(sink.ended).toBe(false);
  });

  it("hands the stream over right at a layout change, and leaves out what only the old layout had", async () => {
    const { sink, layouts, next, clock, feed } = open();
    await feed(tablePackets(H264), tsPackets(3, 256), tsPackets(2, 257));
    const before = sink.pids().length;
    const taker = recordingSink();
    next.sink = taker;
    clock.now += 60_000;
    await feed(
      tsPackets(4, 256),
      tablePackets(MOVED, 0x10_00, 1),
      tsPackets(5, 211),
      // A straggler of the old video, and padding: neither is for the new run.
      tsPackets(1, 256),
      tsPackets(2, NULL_PID),
      tsPackets(3, 221),
    );
    expect(layouts).toHaveLength(2);
    expect(layouts[1]).toMatchObject({ delivered: true });
    expect(describeLayout(layouts[1]?.previous ?? { programs: [], key: "" })).toBe("program 1 [256:h264 257:0x0f]");
    expect(describeLayout(layouts[1]?.layout ?? { programs: [], key: "" })).toBe("program 1 [211:h264 221:0x0f]");
    // The old run got everything up to the change (the PAT before the new PMT too), and its input ended.
    expect(sink.pids().slice(before)).toEqual([256, 256, 256, 256, 0]);
    expect(sink.ended).toBe(true);
    expect(sink.late).toBe(0);
    // The new run starts with the tables, then gets what follows the change.
    expect(taker.pids()).toEqual([0, 0x10_00, 0x10_00, 211, 211, 211, 211, 211, 221, 221, 221]);
    expect(taker.ended).toBe(false);

    // From then on it is the one fed.
    await feed(tsPackets(2, 211));
    expect(taker.pids().slice(-2)).toEqual([211, 211]);
    expect(sink.late).toBe(0);
  });

  it("goes on with the same sink when its owner hands over no other", async () => {
    const { sink, layouts, clock, feed } = open();
    await feed(tablePackets(H264), tsPackets(3, 256));
    clock.now += 60_000;
    await feed(tablePackets(HEVC, 0x10_00, 1), tsPackets(2, 211), tsPackets(1, 256));
    expect(layouts).toHaveLength(2);
    expect(sink.ended).toBe(false);
    // It reads on as it is: no tables of the reader's in between, and nothing left out.
    expect(sink.pids().slice(-5)).toEqual([0, 0x10_00, 211, 211, 256]);
  });

  it("gives the same output however the stream is cut into chunks", async () => {
    const first = concatBytes(tsPackets(7, 256), tablePackets(H264), tsPackets(9, 256));
    const second = concatBytes(tablePackets(MOVED, 0x10_00, 1), tsPackets(11, 211), tsPackets(2, 256));
    const whole = open();
    const wholeTaker = recordingSink();
    await whole.feed(first);
    whole.clock.now += 60_000;
    whole.next.sink = wholeTaker;
    await whole.feed(second);
    expect(wholeTaker.pids()).toEqual([0, 0x10_00, 0x10_00, ...Array.from({ length: 11 }, () => 211)]);

    // The same in chunks that end in the middle of packets, the change's own among them.
    const cut = open();
    const cutTaker = recordingSink();
    const stream = concatBytes(first, second);
    for (let at = 0; at < stream.length; at += 301) {
      if (at < first.length && at + 301 >= first.length) {
        cut.clock.now += 60_000;
        cut.next.sink = cutTaker;
      }
      await cut.feed(stream.subarray(at, at + 301));
    }
    expect(same(cut.sink.bytes(), whole.sink.bytes())).toBe(true);
    expect(same(cutTaker.bytes(), wholeTaker.bytes())).toBe(true);
    expect(cut.sink.ended).toBe(true);
    expect(cut.layouts).toHaveLength(2);
  });

  it("starts over once for tables that flip back and forth, on the layout they settle on", async () => {
    const { layouts, next, clock, feed } = open();
    await feed(tablePackets(H264), tsPackets(3, 256));
    const second = recordingSink();
    next.sink = second;
    clock.now += 10_000;
    await feed(tablePackets(MOVED, 0x10_00, 1), tsPackets(3, 211));
    expect(layouts).toHaveLength(2);
    // A second later the tables change again, and back: nothing starts over for either.
    clock.now += 1000;
    await feed(tablePackets(HEVC, 0x10_00, 2), tsPackets(2, 211));
    clock.now += 500;
    await feed(tablePackets(MOVED, 0x10_00, 3), tsPackets(2, 211));
    clock.now += 5000;
    await feed(tsPackets(2, 211));
    expect(layouts).toHaveLength(2);
    expect(second.ended).toBe(false);

    // A change that stays is followed once the last start is three seconds old, with the next data.
    clock.now += 1000;
    await feed(tablePackets(HEVC, 0x10_00, 4), tsPackets(2, 211));
    expect(layouts).toHaveLength(3);
    const third = recordingSink();
    next.sink = third;
    clock.now += 1000;
    await feed(tablePackets(H264, 0x10_00, 5), tsPackets(2, 256));
    expect(layouts).toHaveLength(3);
    clock.now += 2500;
    await feed(tsPackets(4, 256));
    expect(layouts).toHaveLength(4);
    expect(describeLayout(layouts[3]?.layout ?? { programs: [], key: "" })).toBe("program 1 [256:h264 257:0x0f]");
    expect(third.pids()).toEqual([0, 0x10_00, 256, 256, 256, 256]);
  });

  it("passes on what is not MPEG-TS as it comes", async () => {
    const { sink, layouts, feed } = open();
    const first = noise(40_000);
    await feed(first);
    expect(sink.chunks).toEqual([]);
    const second = noise(40_000);
    await feed(second);
    expect(same(sink.bytes(), concatBytes(first, second))).toBe(true);
    await feed(noise(1000));
    expect(sink.bytes()).toHaveLength(81_000);
    expect(layouts).toEqual([]);
  });

  it("passes on an MPEG-TS stream that has no tables once it held back two megabytes of it", async () => {
    const { sink, layouts, feed } = open();
    await feed(tsPackets(6000, 256));
    expect(sink.chunks).toEqual([]);
    await feed(tsPackets(6000, 256));
    expect(sink.pids()).toHaveLength(12_000);
    await feed(tsPackets(10, 256));
    expect(sink.pids()).toHaveLength(12_010);
    expect(layouts).toEqual([]);
  });

  it("asks again while the engine answers with a text instead of video, without ending", async () => {
    const engine = fakeEngine();
    engine.answers.push(notReady(), notReady());
    const { sink, ends, feed } = open({ retryMs: 10 }, engine);
    await feed(tablePackets(H264), tsPackets(4, 256));
    expect(engine.requests).toHaveLength(3);
    expect(ends).toEqual([]);
    expect(sink.pids().filter((pid) => pid === 256)).toHaveLength(4);
  });

  it("gives up on an engine that is not ready for as long as it would wait for data", async () => {
    const engine = fakeEngine();
    for (let answer = 0; answer < 20; answer += 1) {
      engine.answers.push(
        new Response("failed to seek\n", { headers: { "content-type": "text/plain; charset=utf-8" } }),
      );
    }
    const clock = { now: 0 };
    const ends: SourceEnd[] = [];
    readSource(
      {
        source: "http://engine/play",
        idleTimeoutMs: 60_000,
        retryMs: 1,
        sink: recordingSink(),
        onLayout: () => undefined,
        onEnd: (end) => {
          ends.push(end);
        },
      },
      (url, init) => {
        // Each try takes ten seconds by the reader's clock.
        clock.now += 10_000;
        return engine.fetch(url, init);
      },
      () => clock.now,
    );
    await vi.waitFor(() => {
      expect(ends).toEqual([{ reason: 'the engine answered "failed to seek" instead of video', delivered: false }]);
    });
    expect(engine.requests).toHaveLength(6);
  });

  it("tells of an engine that answers with an error", async () => {
    const engine = fakeEngine();
    engine.answers.push(new Response("no", { status: 500 }));
    const { ends } = open({}, engine);
    await vi.waitFor(() => {
      expect(ends).toEqual([{ reason: "the engine answered 500", delivered: false }]);
    });
    expect(engine.requests).toHaveLength(1);
  });

  it("gives up on an engine that sends nothing for the idle timeout", async () => {
    const { ends, engine } = open({ idleTimeoutMs: 40 });
    await vi.waitFor(() => {
      expect(ends).toEqual([{ reason: "no data from the engine for 0s", delivered: false }]);
    });
    expect(engine.requests[0]?.aborted()).toBe(true);
  });

  it("tells when the engine ends the stream, with what it held back passed on first", async () => {
    const { sink, ends, engine, feed } = open();
    await feed(tsPackets(8, 256));
    expect(sink.chunks).toEqual([]);
    engine.bodies[0]?.close();
    await vi.waitFor(() => {
      expect(ends).toEqual([{ reason: "the engine ended the stream", delivered: true }]);
    });
    expect(sink.pids()).toHaveLength(8);
  });

  it("says nothing more once it was stopped", async () => {
    const { sink, ends, engine, reader, feed } = open();
    await feed(tablePackets(H264), tsPackets(3, 256));
    const got = sink.pids().length;
    reader.stop();
    await vi.waitFor(() => {
      expect(engine.requests[0]?.aborted()).toBe(true);
    });
    await sleep(20);
    expect(ends).toEqual([]);
    expect(sink.pids()).toHaveLength(got);
    expect(sink.ended).toBe(false);
  });

  it("reads the engine no faster than its sink takes the data", async () => {
    const taken: (() => void)[] = [];
    const got: number[] = [];
    const slow: Sink = {
      write: (bytes) => {
        got.push(bytes.length);
        return new Promise<void>((resolve) => {
          taken.push(resolve);
        });
      },
      end: () => undefined,
    };
    const { engine } = open({ sink: slow });
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    engine.bodies[0]?.enqueue(concatBytes(tablePackets(H264), tsPackets(4, 256)));
    await vi.waitFor(() => {
      expect(got).toHaveLength(1);
    });
    engine.bodies[0]?.enqueue(tsPackets(5, 256));
    await sleep(20);
    // The reader's own tables are all it got to pass on: the rest waits for the sink.
    expect(got).toEqual([2 * 188]);
    while (taken.length > 0) {
      taken.shift()?.();
      await sleep(5);
    }
    expect(got.reduce((total, bytes) => total + bytes, 0)).toBe((2 + 2 + 4 + 5) * 188);
  });

  it("counts only the stream's own data as data", async () => {
    const { reader, clock, feed } = open();
    await feed(tablePackets(H264), tsPackets(3, 256));
    expect(reader.status()).toMatchObject({ bytes: 5 * 188, lastDataAt: 1_000_000 });
    clock.now += 5000;
    // Tables and padding keep coming while the broadcast sends no video.
    await feed(tablePackets(H264, 0x10_00, 1), tsPackets(3, NULL_PID));
    expect(reader.status().lastDataAt).toBe(1_000_000);
    await feed(tsPackets(1, 257));
    expect(reader.status().lastDataAt).toBe(1_005_000);
  });
});
