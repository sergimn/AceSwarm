import { describe, expect, it } from "vitest";
import { describeLayout } from "../src/ts-tables.ts";
import { Encoder, FRAME, readPackets, type SeenPacket } from "./es-fixtures.ts";
import { open, recordingSink, type Opened, type RecordingSink } from "./reader-fixtures.ts";
import {
  concatBytes,
  patPackets,
  section,
  sectionPackets,
  tablePackets,
  tsPackets,
  type TableStream,
} from "./ts-fixtures.ts";

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
/** The video moves, the sound stays on its PID. */
const VIDEO_MOVED: TableStream[] = [
  { pid: 211, type: 0x1b },
  { pid: 257, type: 0x0f },
];
/** The video and the sound on each other's PIDs. */
const SWAPPED: TableStream[] = [
  { pid: 257, type: 0x1b },
  { pid: 256, type: 0x0f },
];

/** A PID of its own for the clock, which both layouts share. */
const CLOCK = 500;
/** One packet of the clock's PID. */
const ticks = (): Uint8Array => tsPackets(1, CLOCK);

/** The tables of these streams, with the clock on `CLOCK`. */
function clockedTables(streams: readonly TableStream[], counter: number): Uint8Array {
  const body = [0xe0 | (CLOCK >> 8), CLOCK & 0xff, 0xf0, 0];
  for (const { pid, type } of streams) {
    body.push(type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0);
  }
  const pmt = sectionPackets(0x10_00, section(0x02, 1, Uint8Array.from(body)), counter);
  return concatBytes(patPackets([[1, 0x10_00]], counter), pmt);
}

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

  it("costs nothing when the tables keep switching to a move of the video alone while the data stays where the run reads it", async () => {
    const { sink, layouts, moves, next, clock, feed, encoder } = await playing();
    next.sink = recordingSink();
    // Each look holds the sound, which stays on its PID, but no video comes on the move's.
    for (let flip = 0; flip < 6; flip += 1) {
      await feed(tablePackets(VIDEO_MOVED, 0x10_00, 1), encoder.picture("p"), encoder.picture("p"));
      clock.now += 500;
      await feed(tablePackets(H264, 0x10_00, 0), encoder.picture("idr"), encoder.picture("p"));
      clock.now += 500;
    }
    expect(layouts).toHaveLength(1);
    expect(moves).toEqual([]);
    expect(sink.ended).toBe(false);
    expect(shown(sink)).toHaveLength(3 + 6 * 4);
    expect(shown(sink, 257)).toHaveLength(3 + 6 * 4);
  });

  it("costs nothing when the tables keep switching to a move while the data stays, with the clock on a PID both share", async () => {
    const { sink, layouts, moves, next, clock, feed } = open();
    const encoder = new Encoder({ video: 256, audio: 257, start: 900_000 });
    await feed(clockedTables(H264, 0), encoder.picture("idr"), ticks(), encoder.picture("p"), ticks());
    clock.now += 60_000;
    next.sink = recordingSink();
    for (let flip = 0; flip < 6; flip += 1) {
      await feed(clockedTables(MOVED, 1), encoder.picture("p"), ticks(), encoder.picture("p"), ticks());
      clock.now += 500;
      await feed(clockedTables(H264, 0), encoder.picture("idr"), ticks(), encoder.picture("p"), ticks());
      clock.now += 500;
    }
    expect(layouts).toHaveLength(1);
    expect(moves).toEqual([]);
    expect(sink.ended).toBe(false);
    expect(shown(sink)).toHaveLength(2 + 6 * 4);
  });

  it("costs nothing when the tables keep switching to the video and the sound on each other's PIDs while the data stays", async () => {
    const { sink, layouts, moves, next, clock, feed, encoder } = await playing();
    next.sink = recordingSink();
    // The move's video PID carries the sound: no video comes there.
    for (let flip = 0; flip < 6; flip += 1) {
      await feed(tablePackets(SWAPPED, 0x10_00, 1), encoder.picture("p"), encoder.picture("p"));
      clock.now += 500;
      await feed(tablePackets(H264, 0x10_00, 0), encoder.picture("idr"), encoder.picture("p"));
      clock.now += 500;
    }
    expect(layouts).toHaveLength(1);
    expect(moves).toEqual([]);
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

  it("gives a move up 2.5 seconds after it was first looked at, when it comes back a moment after the last look", async () => {
    const { layouts, next, clock, feed } = await playing();
    next.sink = recordingSink();
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 2000;
    await feed(tablePackets(H264, 0x10_00, 0), there.picture("p"));
    // 2.5 seconds since the first look passed while the run's own table was current.
    clock.now += 600;
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    expect(layouts).toHaveLength(1);
    await feed(there.picture("p"));
    expect(layouts).toHaveLength(2);
    expect(layouts[1]?.unfit).toBe("no picture to go on from in 2.5s");
  });

  it("remembers a look at a move for 2.5 seconds after it was given up", async () => {
    const { layouts, next, clock, feed } = await playing();
    next.sink = recordingSink();
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 200;
    await feed(tablePackets(H264, 0x10_00, 0), there.picture("p"));
    // 1.8 seconds after the look was given up, the move comes back: its patience ends 2.5 seconds after the first look.
    clock.now += 1800;
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 400;
    await feed(there.picture("p"));
    expect(layouts).toHaveLength(1);
    clock.now += 100;
    await feed(there.picture("p"));
    expect(layouts).toHaveLength(2);
  });

  it("looks at a move with the patience whole after a look at it that saw no video", async () => {
    const { layouts, next, clock, feed, encoder } = await playing();
    next.sink = recordingSink();
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    // A look that sees the move's video, given up.
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 300;
    await feed(tablePackets(H264, 0x10_00, 0), encoder.picture("p"));
    // One while the video stays where the run reads it: the move's PIDs carry nothing.
    clock.now += 200;
    await feed(tablePackets(MOVED, 0x10_00, 1), encoder.picture("p"));
    clock.now += 300;
    await feed(tablePackets(H264, 0x10_00, 0), encoder.picture("p"));
    // The move comes back with its video: 2.5 seconds from now.
    clock.now += 200;
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 2400;
    await feed(there.picture("p"));
    expect(layouts).toHaveLength(1);
    clock.now += 100;
    await feed(there.picture("p"));
    expect(layouts).toHaveLength(2);
  });

  it("looks at a move with the patience whole after the run read on over another one", async () => {
    const { layouts, moves, next, clock, feed, encoder } = await playing();
    next.sink = recordingSink();
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    // A look at the move that sees its video, given up; then the move is carried, and one back.
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 300;
    await feed(tablePackets(H264, 0x10_00, 0), encoder.picture("p"));
    clock.now += 100;
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("idr"), there.picture("p"));
    clock.now += 300;
    await feed(tablePackets(H264, 0x10_00, 0), encoder.picture("idr"), encoder.picture("p"));
    expect(moves).toHaveLength(2);
    // The move once more: a move from the run's layout as it is now, with a patience of its own. Its
    // picture to go on from comes 2.4 seconds later, 3.4 seconds after the first look.
    clock.now += 300;
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 2400;
    await feed(there.picture("idr"), there.picture("p"));
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(3);
  });

  it.each([400, 1000])(
    "gives a move that keeps coming back up once, whatever is current when a change may be followed again (%i ms)",
    async (windowMs) => {
      const { sink, layouts, moves, next, clock, feed } = await playing();
      const taker = recordingSink();
      next.sink = taker;
      const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
      // The data is on the move's PIDs; the pictures to start at come while the run's old table is current.
      const window = async (tables: TableStream[], first: "idr" | "p"): Promise<void> => {
        await feed(tablePackets(tables, 0x10_00, tables === MOVED ? 1 : 0), there.picture(first));
        for (let picture = 1; picture < 4; picture += 1) {
          clock.now += windowMs / 4;
          await feed(there.picture("p"));
        }
        clock.now += windowMs / 4;
      };
      for (let flip = 0; flip < 10; flip += 1) {
        await window(MOVED, "p");
        await window(H264, "idr");
      }
      expect(layouts).toHaveLength(2);
      expect(describeLayout(layouts[1]!.layout)).toBe("program 1 [211:h264 221:0x0f]");
      expect(sink.ended).toBe(true);
      // The new run reads on over the old table as it comes and goes: every picture reaches it.
      const from = shown(taker, 211).length;
      for (let flip = 0; flip < 5; flip += 1) {
        await window(MOVED, "p");
        await window(H264, "idr");
      }
      expect(layouts).toHaveLength(2);
      expect(moves).toEqual([]);
      expect(taker.ended).toBe(false);
      expect(shown(taker, 211)).toHaveLength(from + 5 * 8);
    },
  );

  it("reads on over a move in its turn after an earlier change that had to wait came to nothing", async () => {
    const { layouts, moves, next, clock, feed } = open();
    next.sink = recordingSink();
    const encoder = new Encoder({ video: 256, audio: 257, start: 900_000 });
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    await feed(tablePackets(H264), encoder.picture("idr"), encoder.picture("p"));
    // Too soon after the run started, the tables name the move for a moment, with a picture on its PIDs.
    clock.now += 500;
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"));
    clock.now += 500;
    await feed(tablePackets(H264, 0x10_00, 0), encoder.picture("p"));
    // By the time a change may be followed, the tables are the run's again: nothing to follow.
    clock.now += 2500;
    await feed(encoder.picture("p"));
    expect(layouts).toHaveLength(1);
    // A minute later the stream really moves there.
    clock.now += 60_000;
    await feed(tablePackets(MOVED, 0x10_00, 2), there.picture("idr"), there.picture("p"));
    expect(layouts).toHaveLength(1);
    expect(moves).toHaveLength(1);
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

  it("leaves what still comes on the PIDs an earlier run left out of a later run, over a carried move", async () => {
    const { layouts, moves, next, clock, feed } = await playing();
    // The sound moves alone: a new run, and its old PID is no one's.
    const second = recordingSink();
    next.sink = second;
    const sound: TableStream[] = [
      { pid: 256, type: 0x1b },
      { pid: 258, type: 0x0f },
    ];
    const resumed = new Encoder({ video: 256, audio: 258, start: 2_000_000 });
    await feed(tablePackets(sound, 0x10_00, 1), resumed.picture("idr"), resumed.picture("p"));
    expect(layouts).toHaveLength(2);
    clock.now += 60_000;
    // Then the run reads on over a move of both.
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    await feed(tablePackets(MOVED, 0x10_00, 2), there.picture("idr"), there.picture("p"));
    expect(moves).toHaveLength(1);
    // And the stream changes codec: a third run, while the first encoder still sends on its sound's PID.
    const third = recordingSink();
    next.sink = third;
    const hevc: TableStream[] = [
      { pid: 411, type: 0x24 },
      { pid: 421, type: 0x0f },
    ];
    const stale = new Encoder({ video: 256, audio: 257, start: 900_000 });
    const newcomer = new Encoder({ video: 411, audio: 421, start: 9_000_000 });
    await feed(tablePackets(hevc, 0x10_00, 3), stale.picture("p"), newcomer.picture("idr"));
    expect(layouts).toHaveLength(3);
    expect(new Set(seen(third).map((packet) => packet.pid))).toEqual(new Set([0, 0x10_00, 411, 421]));
  });
});
