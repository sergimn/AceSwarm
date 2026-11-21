import { describe, expect, it, vi } from "vitest";
import type { Sink } from "../src/source-reader.ts";
import { adtsFrame, bytesOf, Encoder, FRAME, H264_SETS, nalUnits, readPackets, RECOVERY_POINT } from "./es-fixtures.ts";
import { open, recordingSink, type Opened, type RecordingSink } from "./reader-fixtures.ts";
import { concatBytes, tablePackets, type TableStream } from "./ts-fixtures.ts";

const H264: TableStream[] = [
  { pid: 256, type: 0x1b },
  { pid: 257, type: 0x0f },
];
const HEVC: TableStream[] = [
  { pid: 256, type: 0x24 },
  { pid: 257, type: 0x0f },
];
const MOVED: TableStream[] = [
  { pid: 211, type: 0x1b },
  { pid: 221, type: 0x0f },
];
const START = 900_000;

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const filler = (length: number): Uint8Array => new Uint8Array(length).fill(0xa5);
/** An SEI unit with 250 bytes of user data: what comes before the slice then takes two packets. */
const USER_DATA = `0605fa${"a5".repeat(250)}80`;
const SLICES = { idr: "658884", intra: "418884" };

/** An access unit of H.264: a delimiter, other NAL units, then a slice of the picture. */
const unit = (slice: keyof typeof SLICES, ...before: string[]): Uint8Array =>
  concatBytes(nalUnits("09f0", ...before), bytesOf("000001"), bytesOf(SLICES[slice]), filler(300));

interface Watched extends Opened {
  encoder: Encoder;
  /** The time stamps `found` was told, in order, and the kinds of picture. */
  found: (number | undefined)[];
  points: string[];
  watching: { on: boolean; asked: number };
  /** The sink `found` hands over next; none keeps the one in use. */
  handTo: { sink: Sink | undefined };
  /** One access unit of the video, as its packets, shown at the encoder's next time. */
  video: (bytes: Uint8Array) => Uint8Array;
}

/** A reader whose owner watches for cut points, while `watching.on` says so. */
function watched(): Watched {
  const found: (number | undefined)[] = [];
  const points: string[] = [];
  const watching = { on: true, asked: 0 };
  const handTo: Watched["handTo"] = { sink: undefined };
  const opened = open({
    cutPoints: {
      watching: () => {
        watching.asked += 1;
        return watching.on;
      },
      found: (pts, point) => {
        found.push(pts);
        points.push(point);
        const next = handTo.sink;
        handTo.sink = undefined;
        return next;
      },
    },
  });
  const encoder = new Encoder({ video: 256, audio: 257, start: START });
  const video = (bytes: Uint8Array): Uint8Array => {
    const packets = encoder.writer.pes(256, "video", bytes, { pts: encoder.pts });
    encoder.pts += FRAME;
    return packets;
  };
  return { ...opened, encoder, found, points, watching, handTo, video };
}

/** What a reader whose owner watches for nothing passes on of the same stream. */
async function plainly(...parts: Uint8Array[]): Promise<RecordingSink> {
  const { sink, feed } = open();
  await feed(...parts);
  return sink;
}

/** The stream's tables in front of the rest, as a new run gets them; returns the rest. */
function afterTables(sink: RecordingSink): Uint8Array {
  const bytes = sink.bytes();
  expect(readPackets(bytes.subarray(0, 2 * 188)).map((packet) => packet.pid)).toEqual([0, 0x10_00]);
  return bytes.subarray(2 * 188);
}

describe("readSource watching for where a copy of the video can be cut", () => {
  it("tells of each access unit a copy can be cut at, and passes the stream on as it would otherwise", async () => {
    const { sink, feed, found, points, watching, encoder } = watched();
    const stream = concatBytes(
      tablePackets(H264),
      encoder.picture("idr"),
      encoder.picture("p"),
      encoder.picture("i"),
      encoder.picture("idr"),
      encoder.picture("p"),
    );
    await feed(stream);
    expect(found).toEqual([START, START + 3 * FRAME]);
    expect(points).toEqual(["idr", "idr"]);
    // It is asked once for each access unit of the video.
    expect(watching.asked).toBe(5);
    expect(same(sink.bytes(), (await plainly(stream)).bytes())).toBe(true);
    expect(sink.ended).toBe(false);
  });

  it("cuts after a recovery point too, but not at an I frame without one", async () => {
    const { feed, found, points, video } = watched();
    await feed(
      tablePackets(H264),
      video(unit("intra", ...H264_SETS)),
      video(unit("intra", RECOVERY_POINT)),
      video(unit("intra")),
    );
    expect(found).toEqual([START + FRAME]);
    expect(points).toEqual(["recovery-point"]);
  });

  it("hands over at the unit it is given another sink for: the old one ends right before it, the new one begins with the tables and then the unit", async () => {
    const { sink, feed, handTo, encoder } = watched();
    const before = concatBytes(tablePackets(H264), encoder.picture("idr"), encoder.picture("p"));
    await feed(before);
    const next = recordingSink();
    handTo.sink = next;
    const after = concatBytes(encoder.picture("idr"), encoder.picture("p"), encoder.picture("idr"));
    await feed(after);

    expect(sink.ended).toBe(true);
    expect(sink.late).toBe(0);
    expect(same(sink.bytes(), (await plainly(before)).bytes())).toBe(true);
    expect(same(afterTables(next), after)).toBe(true);
    expect(next.ended).toBe(false);
  });

  it("keeps the packets of other PIDs that come before the unit's first slice with the unit", async () => {
    const { sink, feed, found, handTo, encoder, video } = watched();
    await feed(tablePackets(H264), encoder.picture("idr"));
    const delivered = sink.bytes().length;
    const next = recordingSink();
    handTo.sink = next;
    const packets = video(unit("idr", ...H264_SETS, USER_DATA));
    const sound = encoder.writer.pes(257, "audio", adtsFrame(), { pts: START });
    // The sound comes between the unit's first packet and the one with its slice.
    const stream = concatBytes(packets.subarray(0, 188), sound, packets.subarray(188));
    await feed(stream.subarray(0, 2 * 188));
    // Held back until the slice tells.
    expect(sink.bytes()).toHaveLength(delivered);
    expect(next.bytes()).toHaveLength(0);
    await feed(stream.subarray(2 * 188));

    expect(found).toEqual([START, START + FRAME]);
    expect(sink.bytes()).toHaveLength(delivered);
    expect(same(afterTables(next), stream)).toBe(true);
  });

  it("gives the old run what it held when the layout changes before the unit's slice, as if it had held nothing", async () => {
    const watcher = watched();
    const plain = open();
    const first = concatBytes(tablePackets(H264), watcher.encoder.picture("idr"));
    const start = watcher.video(unit("idr", ...H264_SETS, USER_DATA)).subarray(0, 188);
    const parts = [first, start, tablePackets(HEVC, 0x10_00, 1)];
    const sinks = [watcher, plain].map(async ({ feed, next, clock }) => {
      await feed(parts[0] ?? new Uint8Array(0));
      // Past the time in which a change waits its turn (see `FollowBrake`).
      clock.now += 60_000;
      await feed(parts[1] ?? new Uint8Array(0));
      const layout = recordingSink();
      next.sink = layout;
      await feed(parts[2] ?? new Uint8Array(0));
      return layout;
    });
    const [held, notHeld] = await Promise.all(sinks);

    expect(watcher.found).toEqual([START]);
    expect(watcher.sink.ended).toBe(true);
    // The old run got the unit's start, and the packet after it.
    expect(readPackets(watcher.sink.bytes().subarray(-2 * 188)).map((packet) => packet.pid)).toEqual([256, 0]);
    expect(same(watcher.sink.bytes(), plain.sink.bytes())).toBe(true);
    expect(same(held?.bytes() ?? new Uint8Array(0), notHeld?.bytes() ?? new Uint8Array(1))).toBe(true);
  });

  it("passes on what it held when the stream ends", async () => {
    const { sink, feed, engine, ends, encoder, video } = watched();
    await feed(tablePackets(H264), encoder.picture("idr"));
    const start = video(unit("idr", ...H264_SETS, USER_DATA)).subarray(0, 188);
    await feed(start);
    engine.bodies.at(-1)?.close();
    await vi.waitFor(() => {
      expect(ends).toHaveLength(1);
    });
    expect(same(sink.bytes().subarray(-188), start)).toBe(true);
  });

  it("takes a unit that ends before its first slice for none to cut at, and so the one after it", async () => {
    const { feed, found, video } = watched();
    const sliceless = nalUnits("09f0", ...H264_SETS, RECOVERY_POINT);
    await feed(
      tablePackets(H264),
      video(sliceless),
      video(unit("idr", ...H264_SETS)),
      video(unit("idr", ...H264_SETS)),
    );
    expect(found).toEqual([START + 2 * FRAME]);
  });

  it("looks at no video of a stream that has two: which of them ffmpeg reads is up to ffmpeg", async () => {
    const { feed, found, watching, encoder } = watched();
    const two: TableStream[] = [...H264, { pid: 258, type: 0x1b }];
    await feed(tablePackets(two), encoder.picture("idr"), encoder.picture("idr"));
    expect(watching.asked).toBe(0);
    expect(found).toEqual([]);
  });

  it("holds nothing back while its owner watches for none", async () => {
    const { sink, feed, found, watching, encoder, video } = watched();
    watching.on = false;
    const stream = concatBytes(
      tablePackets(H264),
      encoder.picture("idr"),
      video(unit("idr", ...H264_SETS, USER_DATA)),
      encoder.picture("p"),
    );
    await feed(stream);
    expect(found).toEqual([]);
    expect(watching.asked).toBe(3);
    expect(same(sink.bytes(), (await plainly(stream)).bytes())).toBe(true);
  });

  it("hands over after a move to other PIDs with the stream as it comes now: its tables, PIDs and times", async () => {
    const { sink, feed, found, handTo, moves, clock, encoder } = watched();
    await feed(tablePackets(H264), encoder.picture("idr"), encoder.picture("p"), encoder.picture("p"));
    clock.now += 60_000;
    const there = new Encoder({ video: 211, audio: 221, start: 5_000_000 });
    await feed(tablePackets(MOVED, 0x10_00, 1), there.picture("p"), there.picture("idr"), there.picture("p"));
    expect(moves).toHaveLength(1);
    // The run reads the moved streams under the PIDs it knows.
    const pids = readPackets(sink.bytes()).map((packet) => packet.pid);
    expect(new Set(pids)).toEqual(new Set([0, 0x10_00, 256, 257]));
    const next = recordingSink();
    handTo.sink = next;
    const after = concatBytes(there.picture("idr"), there.picture("p"));
    await feed(after);

    expect(found.at(-1)).toBe(5_000_000 + 3 * FRAME);
    expect(sink.ended).toBe(true);
    expect(same(afterTables(next), after)).toBe(true);
    const tables = readPackets(next.bytes().subarray(0, 2 * 188));
    // The PMT it begins with names the PIDs the streams are on now.
    expect(Buffer.from(tables[1]?.payload ?? []).includes(Buffer.from([0x1b, 0xe0, 211]))).toBe(true);
  });
});
