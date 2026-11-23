import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { readSource, type Sink, type SourceEnd } from "../src/source-reader.ts";
import { describeLayout } from "../src/ts-tables.ts";
import { fakeEngine, open, recordingSink } from "./reader-fixtures.ts";
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

describe("readSource", () => {
  it("holds the stream back until its tables came, and passes it on with the tables first", async () => {
    const { sink, layouts, feed } = open();
    await feed(tsPackets(20, 256));
    expect(sink.chunks).toEqual([]);
    expect(layouts).toEqual([]);

    await feed(tablePackets(H264), tsPackets(10, 256));
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ previous: undefined, delivered: false });
    expect(describeLayout(layouts[0]?.layout ?? { programs: [], key: "" })).toBe("program 1 [256:h264 257:0x0f]");
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
    // That one came within a minute of the one before it: the next waits twice as long.
    clock.now += 1000;
    await feed(tablePackets(H264, 0x10_00, 5), tsPackets(2, 256));
    expect(layouts).toHaveLength(3);
    clock.now += 2500;
    await feed(tsPackets(4, 256));
    expect(layouts).toHaveLength(3);
    clock.now += 2500;
    await feed(tsPackets(4, 256));
    expect(layouts).toHaveLength(4);
    expect(describeLayout(layouts[3]?.layout ?? { programs: [], key: "" })).toBe("program 1 [256:h264 257:0x0f]");
    expect(third.pids()).toEqual([0, 0x10_00, 256, 256, 256, 256]);
  });

  it("starts ffmpeg over less and less often for tables that never settle, and at once again when they did", async () => {
    const { layouts, clock, feed } = open();
    await feed(tablePackets(H264), tsPackets(3, 256));
    clock.now += 100_000;
    const start = clock.now;
    // The tables take turns every second, for four minutes.
    const followed: number[] = [];
    for (let second = 0; second < 240; second += 1) {
      await feed(tablePackets(second % 2 === 0 ? MOVED : H264, 0x10_00, second + 1), tsPackets(1, 256));
      if (layouts.length > followed.length + 1) {
        followed.push((clock.now - start) / 1000);
      }
      clock.now += 1000;
    }
    // The first change at once, then after waits that double up to a minute.
    expect(followed).toEqual([0, 3, 9, 21, 45, 93, 153, 213]);

    // The tables said the same for a minute: their next change is followed at once, and one more three seconds later.
    clock.now += 60_000;
    const before = layouts.length;
    await feed(tablePackets(MOVED, 0x10_00, 1), tsPackets(1, 211));
    expect(layouts).toHaveLength(before + 1);
    clock.now += 1000;
    await feed(tablePackets(H264, 0x10_00, 2), tsPackets(1, 256));
    expect(layouts).toHaveLength(before + 1);
    clock.now += 2000;
    await feed(tsPackets(1, 256));
    expect(layouts).toHaveLength(before + 2);
  });

  it("goes on as it is when the tables change in what no reader of video and audio follows", async () => {
    const { sink, layouts, next, clock, feed } = open();
    await feed(tablePackets(H264), tsPackets(3, 256));
    clock.now += 60_000;
    next.sink = recordingSink();
    // Subtitles come, and the audio names its language.
    const more: TableStream[] = [
      H264[0]!,
      { pid: 257, type: 0x0f, descriptors: [0x0a, 0x04, 0x65, 0x6e, 0x67, 0x00] },
      { pid: 300, type: 0x06, descriptors: [0x59, 0x00] },
    ];
    await feed(tablePackets(more, 0x10_00, 1), tsPackets(2, 256), tsPackets(1, 300));
    expect(layouts).toHaveLength(1);
    expect(sink.ended).toBe(false);
    // The run gets the new tables as they came, and the new stream's packets.
    expect(sink.pids().slice(-5)).toEqual([0, 0x10_00, 256, 256, 300]);
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
      expect(ends).toEqual([{ reason: 'the engine answered "failed to seek" instead of video' }]);
    });
    expect(engine.requests).toHaveLength(6);
  });

  it("tells of an engine that answers with an error", async () => {
    const engine = fakeEngine();
    engine.answers.push(new Response("no", { status: 500 }));
    const { ends } = open({}, engine);
    await vi.waitFor(() => {
      expect(ends).toEqual([{ reason: "the engine answered 500" }]);
    });
    expect(engine.requests).toHaveLength(1);
  });

  it("gives up on an engine that sends nothing for the idle timeout", async () => {
    const { ends, engine } = open({ idleTimeoutMs: 40 });
    await vi.waitFor(() => {
      expect(ends).toEqual([{ reason: "no data from the engine for 0s" }]);
    });
    expect(engine.requests[0]?.aborted()).toBe(true);
  });

  it("does not take the time ffmpeg needs for the data for the engine's silence", async () => {
    // An ffmpeg that takes three times the idle timeout over what it is given first.
    const slow = recordingSink();
    const taken = Promise.withResolvers<undefined>();
    let waits = true;
    const sink: Sink = {
      write: async (bytes) => {
        await slow.write(bytes);
        const first = waits;
        waits = false;
        await (first ? taken.promise : undefined);
      },
      end: slow.end,
    };
    const { ends, engine } = open({ idleTimeoutMs: 40, sink });
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    engine.bodies[0]?.enqueue(concatBytes(tablePackets(H264), tsPackets(3, 256)));
    await sleep(120);
    expect(ends).toEqual([]);
    expect(engine.requests[0]?.aborted()).toBe(false);
    expect(slow.pids().length).toBeGreaterThan(0);

    // Once ffmpeg took it, the engine's silence counts again, from then.
    taken.resolve(undefined);
    await sleep(20);
    expect(ends).toEqual([]);
    await vi.waitFor(() => {
      expect(ends).toEqual([{ reason: "no data from the engine for 0s" }]);
    });
  });

  it("tells when the engine ends the stream, with what it held back passed on first", async () => {
    const { sink, ends, engine, feed } = open();
    await feed(tsPackets(8, 256));
    expect(sink.chunks).toEqual([]);
    engine.bodies[0]?.close();
    await vi.waitFor(() => {
      expect(ends).toEqual([{ reason: "the engine ended the stream" }]);
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

  it("asks an engine that is not ready no more once it was stopped", async () => {
    const engine = fakeEngine();
    engine.answers.push(notReady(), notReady(), notReady(), notReady());
    const { ends, reader } = open({ retryMs: 40 }, engine);
    await vi.waitFor(
      () => {
        expect(engine.requests.length).toBeGreaterThan(0);
      },
      { interval: 1 },
    );
    reader.stop();
    const asked = engine.requests.length;
    await sleep(150);
    expect(engine.requests).toHaveLength(asked);
    expect(ends).toEqual([]);
  });

  it("follows no layout on a chunk that comes in as it is stopped", async () => {
    const { engine, sink, layouts, clock, reader, feed } = open();
    await feed(tablePackets(H264), tsPackets(3, 256));
    expect(layouts).toHaveLength(1);
    const got = sink.pids().length;
    // Long after the first layout: a change would be followed at once.
    clock.now += 10_000;

    // The chunk is already on its way to the reader when its owner stops it.
    engine.bodies[0]?.enqueue(concatBytes(tablePackets(HEVC, 0x10_00, 1), tsPackets(3, 211)));
    reader.stop();
    await sleep(20);

    // The owner is asked for no run on the new layout, and nothing more is passed on.
    expect(layouts).toHaveLength(1);
    expect(sink.pids()).toHaveLength(got);
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
});
