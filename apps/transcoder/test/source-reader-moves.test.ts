import { describe, expect, it } from "vitest";
import { describeLayout } from "../src/ts-tables.ts";
import {
  adtsFrame,
  Encoder,
  FRAME,
  readPackets,
  SETS,
  TsWriter,
  type EncoderOptions,
  type SeenPacket,
} from "./es-fixtures.ts";
import { open, recordingSink, type Opened, type RecordingSink } from "./reader-fixtures.ts";
import { concatBytes, tablePackets, type TableStream } from "./ts-fixtures.ts";

const H264: TableStream[] = [
  { pid: 256, type: 0x1b },
  { pid: 257, type: 0x0f },
];
const MOVED: TableStream[] = [
  { pid: 211, type: 0x1b },
  { pid: 221, type: 0x0f },
];
const MOVED_AGAIN: TableStream[] = [
  { pid: 311, type: 0x1b },
  { pid: 321, type: 0x0f },
];

const original = (): Encoder => new Encoder({ video: 256, audio: 257, start: 900_000 });
const moved = (options: Partial<EncoderOptions> = {}): Encoder =>
  new Encoder({ video: 211, audio: 221, start: 5_000_000, ...options });

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const seen = (sink: RecordingSink): SeenPacket[] => readPackets(sink.bytes());
/** When each picture a run got on the video PID it knows is shown. */
const shown = (sink: RecordingSink, pid = 256): (number | undefined)[] =>
  seen(sink)
    .filter((packet) => packet.pid === pid && packet.start)
    .map((packet) => packet.pts);

/** A reader whose run has read the tables and three pictures of the original encoder, long enough ago. */
async function playing(): Promise<Opened & { encoder: Encoder; lastPts: number }> {
  const opened = open();
  const encoder = original();
  await opened.feed(tablePackets(H264), encoder.picture("idr"), encoder.picture("p"), encoder.picture("p"));
  expect(opened.layouts).toHaveLength(1);
  // A stream's first layout is no move that failed.
  expect(opened.layouts[0]?.unfit).toBeUndefined();
  // Past the time in which a change waits its turn (see `FollowBrake`).
  opened.clock.now += 60_000;
  return { ...opened, encoder, lastPts: encoder.pts - FRAME };
}

describe("readSource over a move to other PIDs", () => {
  it("passes the moved streams on under the PIDs the run knows, and asks for no other sink", async () => {
    const { sink, layouts, moves, next, feed, lastPts } = await playing();
    const before = seen(sink).length;
    // A sink it would hand the stream to, if it were asked.
    next.sink = recordingSink();
    const there = moved();
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"), there.picture("idr"), there.picture("p"));

    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.inPlace).toBe(false);
    expect(describeLayout(moves[0]!.previous)).toBe("program 1 [256:h264 257:0x0f]");
    expect(describeLayout(moves[0]!.layout)).toBe("program 1 [211:h264 221:0x0f]");
    expect(sink.ended).toBe(false);
    // The PAT says nothing new and passes; the new PMT is left out, and so is the picture before the first a decoder can start at.
    const after = seen(sink).slice(before);
    expect(after[0]?.pid).toBe(0);
    expect(new Set(after.slice(1).map((packet) => packet.pid))).toEqual(new Set([256, 257]));
    expect(shown(sink).slice(-2)).toEqual([lastPts + FRAME, lastPts + 2 * FRAME]);

    // What follows goes the same way, and what the old encoder still sends is left out.
    const length = seen(sink).length;
    await feed(original().picture("p"), there.picture("p"));
    expect(
      new Set(
        seen(sink)
          .slice(length)
          .map((packet) => packet.pid),
      ),
    ).toEqual(new Set([256, 257]));
    expect(shown(sink).slice(-3)).toEqual([lastPts + FRAME, lastPts + 2 * FRAME, lastPts + 3 * FRAME]);
    expect(layouts).toHaveLength(1);
  });

  it("gives the same output however the stream is cut into chunks", async () => {
    const there = moved();
    const old = original();
    const first = concatBytes(tablePackets(H264), old.picture("idr"), old.picture("p"), old.picture("p"));
    const second = concatBytes(
      tablePackets(MOVED, 0x10_00, 1),
      there.picture("p"),
      old.picture("p"),
      there.picture("idr"),
      there.picture("p"),
      tablePackets(MOVED, 0x10_00, 2),
      there.picture("p"),
    );
    const whole = open();
    await whole.feed(first);
    whole.clock.now += 60_000;
    await whole.feed(second);
    expect(whole.moves).toHaveLength(1);

    // The same in chunks that end in the middle of packets.
    const cut = open();
    const stream = concatBytes(first, second);
    for (let at = 0; at < stream.length; at += 301) {
      if (at < first.length && at + 301 >= first.length) {
        cut.clock.now += 60_000;
      }
      await cut.feed(stream.subarray(at, at + 301));
    }
    expect(cut.moves).toHaveLength(1);
    expect(cut.layouts).toHaveLength(1);
    expect(same(cut.sink.bytes(), whole.sink.bytes())).toBe(true);
  });

  it("starts a new run with everything since the change when the decoders can't go on", async () => {
    const { sink, layouts, moves, next, feed } = await playing();
    const taker = recordingSink();
    next.sink = taker;
    // The new encoder's picture is another size.
    const there = moved({ sets: [SETS.smallSps, SETS.pps] });
    const tables = tablePackets(MOVED, 0x10_00, 1);
    const since = concatBytes(there.picture("p"), there.picture("idr"), there.picture("p"));
    await feed(tables, since);

    expect(moves).toEqual([]);
    expect(layouts).toHaveLength(2);
    expect(layouts[1]).toMatchObject({ delivered: true, unfit: "the video's decoder settings differ" });
    expect(sink.ended).toBe(true);
    expect(sink.late).toBe(0);
    // The new run gets the tables, then the stream from the change on, as it came: nothing rewritten, nothing left out.
    expect(taker.pids().slice(0, 2)).toEqual([0, 0x10_00]);
    expect(same(taker.bytes().subarray(2 * 188), since)).toBe(true);

    // It reads the new layout as it comes from then on, and a later move is looked at from there.
    const more = there.picture("p");
    await feed(more);
    expect(same(taker.bytes().subarray(-more.length), more)).toBe(true);
  });

  it("starts a new run when no picture to go on from came for 2.5 seconds", async () => {
    const { sink, layouts, moves, next, clock, feed } = await playing();
    const taker = recordingSink();
    next.sink = taker;
    const there = moved();
    const held = concatBytes(there.picture("p"), there.picture("p"));
    await feed(tablePackets(MOVED, 0x10_00, 1), held);
    clock.now += 2499;
    const more = there.picture("p");
    await feed(more);
    expect(layouts).toHaveLength(1);
    expect(sink.ended).toBe(false);

    clock.now += 1;
    const last = there.picture("p");
    await feed(last);
    expect(layouts).toHaveLength(2);
    expect(layouts[1]).toMatchObject({ delivered: true, unfit: "no picture to go on from in 2.5s" });
    expect(moves).toEqual([]);
    expect(sink.ended).toBe(true);
    expect(same(taker.bytes().subarray(2 * 188), concatBytes(held, more, last))).toBe(true);
  });

  it("starts a new run for a change that had to wait its turn", async () => {
    const { sink, layouts, moves, next, clock, feed } = open();
    const old = original();
    await feed(tablePackets(H264), old.picture("idr"), old.picture("p"));
    // One second after the run started: too soon to follow a change, which a move would not need.
    clock.now += 1000;
    const there = moved();
    const early = concatBytes(tablePackets(MOVED, 0x10_00, 1), there.picture("idr"));
    await feed(early);
    expect(layouts).toHaveLength(1);
    expect(moves).toEqual([]);
    // The run got the stream as it came meanwhile, new tables and all: it can't be carried from there.
    expect(same(sink.bytes().subarray(-early.length), early)).toBe(true);

    const taker = recordingSink();
    next.sink = taker;
    clock.now += 2000;
    const later = there.picture("p");
    await feed(later);
    expect(layouts).toHaveLength(2);
    expect(layouts[1]?.unfit).toBe("the change had to wait its turn, and the run got the stream as it came meanwhile");
    expect(moves).toEqual([]);
    expect(sink.ended).toBe(true);
    expect(same(taker.bytes().subarray(2 * 188), later)).toBe(true);
  });

  it("reads on when the tables go back before the move was decided", async () => {
    const { sink, layouts, moves, feed, encoder, lastPts } = await playing();
    const there = moved();
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    const before = seen(sink).length;
    // Back to the layout the run reads: what was held of the other one is of no use.
    await feed(tablePackets(H264, 0x10_00, 2), encoder.picture("p"), there.picture("idr"), encoder.picture("p"));
    expect(layouts).toHaveLength(1);
    expect(moves).toEqual([]);
    expect(sink.ended).toBe(false);
    const after = seen(sink).slice(before);
    // The run's own table passes again (the PAT came while the move was still looked at), and nothing of the other layout does.
    expect(new Set(after.map((packet) => packet.pid))).toEqual(new Set([0x10_00, 256, 257]));
    expect(shown(sink).slice(-2)).toEqual([lastPts + FRAME, lastPts + 2 * FRAME]);
  });

  it("looks at the layout the stream has now when it changes again before the move was decided", async () => {
    const { sink, layouts, moves, feed, lastPts } = await playing();
    const second = moved();
    await feed(tablePackets(MOVED, 0x10_00, 1), second.picture("p"));
    const third = new Encoder({ video: 311, audio: 321, start: 77_000_000 });
    await feed(tablePackets(MOVED_AGAIN, 0x10_00, 2), second.picture("idr"), third.picture("idr"), third.picture("p"));
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(describeLayout(moves[0]!.layout)).toBe("program 1 [311:h264 321:0x0f]");
    // Nothing of the layout in between reached ffmpeg, though it had a picture to start at by then.
    expect(shown(sink).slice(-2)).toEqual([lastPts + FRAME, lastPts + 2 * FRAME]);
    const pids = new Set(seen(sink).map((packet) => packet.pid));
    expect(pids).toEqual(new Set([0, 0x10_00, 256, 257]));
  });

  it("takes tables that move while the streams stay for no change of the stream", async () => {
    const { sink, layouts, moves, next, feed, encoder, lastPts } = await playing();
    next.sink = recordingSink();
    const before = seen(sink).length;
    // The program's table is on another PID from here on.
    const picture = encoder.picture("p");
    await feed(tablePackets(H264, 0x10_01, 1), picture);
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.inPlace).toBe(true);
    expect(sink.ended).toBe(false);
    // The PAT passed before the change was known; the new table is left out, the streams pass untouched.
    const after = sink.bytes().subarray(before * 188);
    expect(seen(sink)[before]?.pid).toBe(0);
    expect(same(after.subarray(188), picture)).toBe(true);
    expect(shown(sink).at(-1)).toBe(lastPts + FRAME);

    // The run reads on from there: the layout it is on is the one the stream has.
    const more = encoder.picture("p");
    await feed(more);
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(same(sink.bytes().subarray(-more.length), more)).toBe(true);
  });

  it("knows a run's streams from what came before the stream's tables", async () => {
    const { sink, layouts, moves, clock, feed } = open();
    const encoder = original();
    // The only picture with decoder settings comes first, the tables after it.
    await feed(encoder.picture("idr"), tablePackets(H264), encoder.picture("p"));
    expect(sink.pids().slice(0, 3)).toEqual([0, 0x10_00, 256]);
    clock.now += 60_000;
    const there = moved();
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("idr"));
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(shown(sink)).toEqual([900_000, 900_000 + FRAME, 900_000 + 2 * FRAME]);
  });

  it("takes a move back to PIDs the stream left when an earlier run ended", async () => {
    const { layouts, moves, next, clock, feed } = await playing();
    const taker = recordingSink();
    next.sink = taker;
    // Another picture size on other PIDs: a new run reads those.
    const small = [SETS.smallSps, SETS.pps];
    const there = moved({ sets: small });
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("idr"), there.picture("p"));
    expect(layouts).toHaveLength(2);
    const lastPts = there.pts - FRAME;

    // The same pictures go back to the PIDs the stream was on at first, which the new run was not given since.
    clock.now += 60_000;
    const back = new Encoder({ video: 256, audio: 257, start: 40_000_000, sets: small });
    await feed(tablePackets(H264, 0x10_00, 2), back.picture("idr"), back.picture("p"));
    expect(layouts).toHaveLength(2);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.inPlace).toBe(false);
    expect(describeLayout(moves[0]!.previous)).toBe("program 1 [211:h264 221:0x0f]");
    // The run gets them on the PIDs it started with.
    expect(shown(taker, 211).slice(-3)).toEqual([lastPts, lastPts + FRAME, lastPts + 2 * FRAME]);
    expect(new Set(taker.pids())).toEqual(new Set([0, 0x10_00, 211, 221]));
  });

  it("reads on when a stream the run doesn't read comes, and leaves it out", async () => {
    const { sink, layouts, moves, next, feed, encoder, lastPts } = await playing();
    next.sink = recordingSink();
    const extraStream = { pid: 300, type: 0x0f };
    const writer = new TsWriter();
    const extra = (): Uint8Array => writer.pes(300, "audio", adtsFrame(), { pts: 123_000 });
    const before = seen(sink).length;
    const picture = encoder.picture("p");
    // A second audio stream begins: the tables name it, and its packets come among the others.
    await feed(tablePackets([...H264, extraStream], 0x10_00, 1), extra(), picture, extra());
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.inPlace).toBe(true);
    expect(describeLayout(moves[0]!.layout)).toBe("program 1 [256:h264 257:0x0f 300:0x0f]");
    expect(sink.ended).toBe(false);
    // The run got the PAT, which says nothing new, and its own streams untouched.
    expect(seen(sink)[before]?.pid).toBe(0);
    expect(same(sink.bytes().subarray((before + 1) * 188), picture)).toBe(true);
    expect(shown(sink).at(-1)).toBe(lastPts + FRAME);

    // The stream ends again: still the same run.
    const last = encoder.picture("p");
    await feed(tablePackets(H264, 0x10_00, 2), last);
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(2);
    expect(same(sink.bytes().subarray(-last.length), last)).toBe(true);
  });

  it("reads on over a change that had to wait when the run's streams are where they were", async () => {
    const { sink, layouts, moves, next, clock, feed } = open();
    const old = original();
    await feed(tablePackets(H264), old.picture("idr"), old.picture("p"));
    // One second after the run started, the program's table moves to another PID: too soon to follow.
    clock.now += 1000;
    const early = concatBytes(tablePackets(H264, 0x10_01, 1), old.picture("p"));
    await feed(early);
    expect(moves).toEqual([]);
    expect(same(sink.bytes().subarray(-early.length), early)).toBe(true);

    // When its turn comes, there is nothing to start over for.
    next.sink = recordingSink();
    clock.now += 2000;
    const later = old.picture("p");
    await feed(later);
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.inPlace).toBe(true);
    expect(sink.ended).toBe(false);
    expect(same(sink.bytes().subarray(-later.length), later)).toBe(true);
  });
});
