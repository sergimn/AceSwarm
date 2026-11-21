import { describe, expect, it } from "vitest";
import { describeLayout } from "../src/ts-tables.ts";
import { Encoder, FRAME, readPackets, type SeenPacket } from "./es-fixtures.ts";
import { open, recordingSink, type Opened, type RecordingSink } from "./reader-fixtures.ts";
import { tablePackets, type TableStream } from "./ts-fixtures.ts";

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

const seen = (sink: RecordingSink): SeenPacket[] => readPackets(sink.bytes());
/** When each picture a run got on a video PID is shown. */
const shown = (sink: RecordingSink, pid = 256): (number | undefined)[] =>
  seen(sink)
    .filter((packet) => packet.pid === pid && packet.start)
    .map((packet) => packet.pts);

/** A reader whose run has read the tables and three pictures of the original encoder, long enough ago. */
async function playing(): Promise<Opened & { encoder: Encoder }> {
  const opened = open();
  const encoder = new Encoder({ video: 256, audio: 257, start: 900_000 });
  await opened.feed(tablePackets(H264), encoder.picture("idr"), encoder.picture("p"), encoder.picture("p"));
  // Past the time in which a change waits its turn (see `FollowBrake`).
  opened.clock.now += 60_000;
  return { ...opened, encoder };
}

/** A reader whose run read on over a move to PIDs 211 and 221: its last picture was the original's third and the move's second. */
async function carried(): Promise<Opened & { there: Encoder; lastPts: number }> {
  const opened = await playing();
  const lastPts = opened.encoder.pts - FRAME;
  const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
  await opened.feed(tablePackets(MOVED, 0x10_00, 1), there.picture("idr"), there.picture("p"));
  expect(opened.moves).toHaveLength(1);
  expect(shown(opened.sink).slice(-2)).toEqual([lastPts + FRAME, lastPts + 2 * FRAME]);
  return { ...opened, there, lastPts };
}

describe("readSource over a move that comes back", () => {
  it("gives a move that keeps coming back up once it was looked at for 2.5 seconds in all", async () => {
    const { sink, layouts, moves, next, clock, feed } = await playing();
    const taker = recordingSink();
    next.sink = taker;
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    // The tables switch every half second between the move and the run's layout, while the data is on
    // the move's PIDs, and the pictures to start at come while the run's table is current: each look
    // is given up before one comes, and is shorter than the patience.
    const flip = async (): Promise<void> => {
      await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"), there.picture("p"));
      clock.now += 500;
      await feed(tablePackets(H264, 0x10_00, 0), there.picture("idr"), there.picture("p"));
      clock.now += 500;
    };
    await flip();
    await flip();
    expect(layouts).toHaveLength(1);

    // The third look ends 2.5 seconds after the first began: a new run takes the move's PIDs on.
    await flip();
    expect(layouts).toHaveLength(2);
    expect(layouts[1]?.unfit).toBe("no picture to go on from in 2.5s");
    expect(describeLayout(layouts[1]!.layout)).toBe("program 1 [211:h264 221:0x0f]");
    expect(sink.ended).toBe(true);
    // It got the picture to start at that came right after, and every picture from then on, while
    // the tables go on switching.
    const from = shown(taker, 211).length;
    expect(from).toBeGreaterThanOrEqual(2);
    for (let count = 0; count < 5; count += 1) {
      await flip();
    }
    expect(layouts).toHaveLength(2);
    expect(moves).toEqual([]);
    expect(shown(taker, 211)).toHaveLength(from + 5 * 4);
  });

  it("costs nothing when the tables keep switching to a move and back while the data stays where the run reads it", async () => {
    const { sink, layouts, moves, next, clock, feed, encoder } = await playing();
    next.sink = recordingSink();
    // Six seconds of looks at a move whose PIDs carry nothing: no new run for that.
    for (let flip = 0; flip < 6; flip += 1) {
      await feed(tablePackets(MOVED, 0x10_00, 1), encoder.picture("p"), encoder.picture("p"));
      clock.now += 500;
      await feed(tablePackets(H264, 0x10_00, 0), encoder.picture("idr"), encoder.picture("p"));
      clock.now += 500;
    }
    expect(layouts).toHaveLength(1);
    expect(moves).toEqual([]);
    expect(sink.ended).toBe(false);
    expect(shown(sink)).toHaveLength(3 + 6 * 4);
  });

  it("looks at a move again with the patience whole, once the last look was given up long enough ago", async () => {
    const { layouts, next, clock, feed } = await playing();
    next.sink = recordingSink();
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 2000;
    await feed(tablePackets(H264, 0x10_00, 0), there.picture("p"));
    // 2.5 seconds after the look was given up, the same move is a new one.
    clock.now += 2500;
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 2000;
    await feed(there.picture("p"));
    expect(layouts).toHaveLength(1);
    clock.now += 500;
    await feed(there.picture("p"));
    expect(layouts).toHaveLength(2);
  });

  it("gives a move to yet other PIDs a patience of its own", async () => {
    const { layouts, next, clock, feed } = await playing();
    next.sink = recordingSink();
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    const further = new Encoder({ video: 311, audio: 321, start: 7_000_000 });
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 2000;
    await feed(tablePackets(MOVED_AGAIN, 0x10_00, 2), further.picture("p"));
    clock.now += 2000;
    await feed(further.picture("p"));
    expect(layouts).toHaveLength(1);
    clock.now += 500;
    await feed(further.picture("p"));
    expect(layouts).toHaveLength(2);
  });

  it("keeps a carried move as it was when a move is looked at after it and the tables go back", async () => {
    const { sink, feed, there, lastPts, layouts, moves } = await carried();
    // The tables name yet other PIDs, and nothing to go on from comes there; then they go back.
    await feed(tablePackets(MOVED_AGAIN, 0x10_00, 2), there.picture("p"));
    await feed(tablePackets(MOVED, 0x10_00, 3), there.picture("p"), there.picture("p"));
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    // The run reads on under the PIDs it knows, through the look and after it.
    expect(shown(sink).slice(-5)).toEqual([1, 2, 3, 4, 5].map((count) => lastPts + count * FRAME));
    expect(new Set(seen(sink).map((packet) => packet.pid))).toEqual(new Set([0, 0x10_00, 256, 257]));
  });

  it("keeps a carried move as it was when a move is looked at after it and the tables then change in place", async () => {
    const { sink, feed, there, lastPts, layouts, moves } = await carried();
    await feed(tablePackets(MOVED_AGAIN, 0x10_00, 2), there.picture("p"));
    // The tables add a second sound beside the streams where they are.
    const second: TableStream[] = [...MOVED, { pid: 223, type: 0x0f }];
    await feed(tablePackets(second, 0x10_00, 3), there.picture("p"), there.picture("p"));
    expect(layouts).toHaveLength(1);
    expect(moves.map((move) => move.inPlace)).toEqual([false, true]);
    expect(shown(sink).slice(-3)).toEqual([3, 4, 5].map((count) => lastPts + count * FRAME));
    expect(new Set(seen(sink).map((packet) => packet.pid))).toEqual(new Set([0, 0x10_00, 256, 257]));
  });

  it("keeps the sound that stays on its PID over a move of the video", async () => {
    const { sink, layouts, moves, feed } = await playing();
    const sound = shown(sink, 257).length;
    // The video moves, the sound stays where it was.
    const partly: TableStream[] = [
      { pid: 211, type: 0x1b },
      { pid: 257, type: 0x0f },
    ];
    const there = new Encoder({ video: 211, audio: 257, start: 5_000_000 });
    await feed(tablePackets(partly, 0x10_00, 1), there.picture("idr"), there.picture("p"), there.picture("p"));
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
    expect(shown(sink).length).toBe(3 + 3);
    expect(shown(sink, 257).length).toBe(sound + 3);
  });

  it("leaves what still comes on the PIDs a carried move left out of a later run", async () => {
    const { feed, there, layouts, next } = await carried();
    const taker = recordingSink();
    next.sink = taker;
    const hevc: TableStream[] = [
      { pid: 411, type: 0x24 },
      { pid: 421, type: 0x0f },
    ];
    // The old encoder still sends after the stream changed codec.
    const stale = new Encoder({ video: 256, audio: 257, start: 900_000 });
    const newcomer = new Encoder({ video: 411, audio: 421, start: 9_000_000 });
    await feed(tablePackets(hevc, 0x10_00, 2), there.picture("p"), stale.picture("p"), newcomer.picture("idr"));
    expect(layouts).toHaveLength(2);
    expect(new Set(seen(taker).map((packet) => packet.pid))).toEqual(new Set([0, 0x10_00, 411, 421]));
  });
});
