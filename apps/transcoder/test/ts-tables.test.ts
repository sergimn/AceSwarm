import { describe, expect, it } from "vitest";
import { TsPackets } from "../src/ts-packets.ts";
import {
  changeKind,
  crc32,
  describeLayout,
  LayoutChanges,
  streamPids,
  TsTables,
  videoCodecOf,
  videoCodecOfLayout,
  type Layout,
} from "../src/ts-tables.ts";
import {
  concatBytes,
  patPackets,
  patSection,
  pmtPackets,
  pmtSection,
  REAL_PMT_PID,
  REAL_TABLES,
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
const HEVC: TableStream[] = [
  { pid: 211, type: 0x24 },
  { pid: 221, type: 0x0f },
];

/** Feeds whole packets, and returns every layout the follower told of, in order. */
function feed(tables: TsTables, ...parts: Uint8Array[]): Layout[] {
  const told: Layout[] = [];
  const bytes = concatBytes(...parts);
  for (let at = 0; at < bytes.length; at += 188) {
    const layout = tables.packet(bytes, at);
    if (layout !== undefined) {
      told.push(layout);
    }
  }
  return told;
}

/** The codec the tables name for a stream of this type with these descriptors. */
const codec = (type: number, descriptors: number[] = []): string | undefined =>
  videoCodecOf({ pid: 256, type, descriptors: Uint8Array.from(descriptors) });

/** A language descriptor ("eng"), then a registration descriptor with these four letters. */
const LANGUAGE = [0x0a, 0x04, 0x65, 0x6e, 0x67, 0x00];
const registration = (letters: string): number[] => [...LANGUAGE, 0x05, 0x04, ...Buffer.from(letters)];

describe("crc32", () => {
  it("is CRC-32/MPEG-2", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0x03_76_e6_e7);
  });

  it("gives 0 over a whole section, CRC included", () => {
    expect(crc32(REAL_TABLES.pat.subarray(5, 5 + 16))).toBe(0);
    expect(crc32(pmtSection(1, H264))).toBe(0);
  });
});

describe("TsTables", () => {
  it("learns what a stream carries from the tables ffmpeg's muxer writes", () => {
    const tables = new TsTables();
    expect(tables.layout).toBeUndefined();
    expect(feed(tables, REAL_TABLES.pat)).toEqual([]);
    const [layout] = feed(tables, REAL_TABLES.h264);
    expect(layout?.programs).toEqual([
      {
        number: 1,
        pmtPid: REAL_PMT_PID,
        pcrPid: 256,
        streams: [
          { pid: 256, type: 0x1b, descriptors: new Uint8Array(0) },
          { pid: 257, type: 0x0f, descriptors: new Uint8Array(0) },
        ],
      },
    ]);
    expect(tables.layout).toBe(layout);
    expect(describeLayout(layout!)).toBe("program 1 [256:h264 257:0x0f]");
    expect(videoCodecOfLayout(layout!)).toBe("h264");
    expect([...streamPids(layout!)]).toEqual([256, 257]);
    expect(tables.carriesTables(0)).toBe(true);
    expect(tables.carriesTables(REAL_PMT_PID)).toBe(true);
    expect(tables.carriesTables(256)).toBe(false);
  });

  it("tells of a layout once, however often the same tables come", () => {
    const tables = new TsTables();
    expect(feed(tables, REAL_TABLES.pat, REAL_TABLES.h264)).toHaveLength(1);
    expect(feed(tables, REAL_TABLES.pat, REAL_TABLES.h264, REAL_TABLES.pat, REAL_TABLES.h264)).toEqual([]);
  });

  it("follows a broadcast that moves its video to other PIDs and to another codec under the same PMT version", () => {
    const tables = new TsTables();
    const [first] = feed(tables, REAL_TABLES.pat, REAL_TABLES.h264);
    const [moved] = feed(tables, REAL_TABLES.pat, REAL_TABLES.h264Moved);
    const [hevc] = feed(tables, REAL_TABLES.pat, REAL_TABLES.hevc);
    const [back] = feed(tables, REAL_TABLES.pat, REAL_TABLES.h264);
    expect([first, moved, hevc, back].map((layout) => describeLayout(layout!))).toEqual([
      "program 1 [256:h264 257:0x0f]",
      "program 1 [211:h264 221:0x0f]",
      "program 1 [211:hevc 221:0x0f]",
      "program 1 [256:h264 257:0x0f]",
    ]);
    expect(changeKind(first!, moved!)).toBe("pid");
    expect(changeKind(moved!, hevc!)).toBe("codec");
    expect(changeKind(hevc!, back!)).toBe("codec");
    // The same layout again is the same to a demuxer: a stream that flips back is where it was.
    expect(back?.key).toBe(first?.key);
    expect(moved?.key).not.toBe(first?.key);
  });

  it("takes a new version of the same tables for no change", () => {
    const tables = new TsTables();
    feed(tables, tablePackets(H264));
    const again = concatBytes(
      sectionPackets(0, patSection([[1, 0x10_00]], 5), 1),
      sectionPackets(0x10_00, pmtSection(1, H264, { version: 7 }), 1),
    );
    expect(feed(tables, again)).toEqual([]);
  });

  it("tells of a change that is not about the video as another kind", () => {
    const tables = new TsTables();
    const [before] = feed(tables, tablePackets(H264));
    const ac3 = [H264[0]!, { pid: 257, type: 0x81 }];
    const [after] = feed(tables, pmtPackets(ac3, 1));
    expect(changeKind(before!, after!)).toBe("other");
    const more = [...H264, { pid: 300, type: 0x06, descriptors: [0x59, 0x00] }];
    expect(feed(tables, pmtPackets(more, 2))).toHaveLength(1);
  });

  it("leaves the layout as it is when a section is damaged", () => {
    const tables = new TsTables();
    feed(tables, tablePackets(H264));
    const damaged = pmtPackets(HEVC, 1);
    damaged[20] = (damaged[20] ?? 0) ^ 0x01;
    expect(feed(tables, damaged)).toEqual([]);
    expect(describeLayout(tables.layout!)).toBe("program 1 [256:h264 257:0x0f]");
    // The next one that is whole counts.
    expect(feed(tables, pmtPackets(HEVC, 2))).toHaveLength(1);
  });

  it("leaves the layout as it is for a table that lists no streams, or whose lengths don't add up", () => {
    const tables = new TsTables();
    feed(tables, tablePackets(H264));
    expect(feed(tables, pmtPackets([], 1))).toEqual([]);
    // A section that is valid by its CRC, with a program info length that runs past its end.
    const overrun = section(0x02, 1, Uint8Array.of(0xe1, 0x00, 0xf0, 0x40, 0x1b, 0xe1, 0x00, 0xf0, 0x00));
    expect(feed(tables, sectionPackets(0x10_00, overrun, 2))).toEqual([]);
    // And one too short to be a program table at all.
    const short = section(0x02, 1, new Uint8Array(0));
    expect(feed(tables, sectionPackets(0x10_00, short, 3))).toEqual([]);
    expect(describeLayout(tables.layout!)).toBe("program 1 [256:h264 257:0x0f]");
    expect(feed(tables, pmtPackets(HEVC, 4))).toHaveLength(1);
  });

  it("ignores packets with the transport error flag, and tables sent ahead of time", () => {
    const tables = new TsTables();
    feed(tables, tablePackets(H264));
    const flagged = pmtPackets(HEVC, 1);
    flagged[1] = (flagged[1] ?? 0) | 0x80;
    expect(feed(tables, flagged)).toEqual([]);
    const next = sectionPackets(0x10_00, pmtSection(1, HEVC, { version: 1, current: false }), 1);
    expect(feed(tables, next)).toEqual([]);
  });

  it("puts together a section that spans packets, and drops one that lost a packet", () => {
    const long = [...H264, { pid: 300, type: 0x06, descriptors: Array.from({ length: 250 }, (_, index) => index) }];
    const packets = pmtPackets(long);
    expect(packets.length).toBe(2 * 188);
    const tables = new TsTables();
    feed(tables, patPackets([[1, 0x10_00]]));
    // Only its second packet: nothing to put together.
    expect(feed(tables, packets.subarray(188))).toEqual([]);
    const [layout] = feed(tables, packets);
    expect(layout?.programs[0]?.streams[2]?.descriptors).toHaveLength(250);

    const lost = new TsTables();
    feed(lost, patPackets([[1, 0x10_00]]));
    const second = pmtPackets(long, 3).subarray(188);
    expect(feed(lost, packets.subarray(0, 188), second)).toEqual([]);
  });

  it("finds a section that ends, and one that starts, in the middle of a packet", () => {
    const first = pmtSection(1, [
      ...H264,
      { pid: 300, type: 0x06, descriptors: Array.from({ length: 200 }, () => 0x2a) },
    ]);
    const rest = first.subarray(183);
    // The first packet holds the start of one section; the second its end, then (if any) the next section.
    const packets = (second?: Uint8Array): Uint8Array => {
      const bytes = new Uint8Array(2 * 188).fill(0xff);
      bytes.set([0x47, 0x50, 0x00, 0x10, 0], 0);
      bytes.set(first.subarray(0, 183), 5);
      bytes.set([0x47, 0x50, 0x00, 0x11, rest.length], 188);
      bytes.set(rest, 188 + 5);
      bytes.set(second ?? [], 188 + 5 + rest.length);
      return bytes;
    };
    const pat = patPackets([[1, 0x10_00]]);
    const one = new TsTables();
    feed(one, pat);
    expect(feed(one, packets()).map((layout) => describeLayout(layout))).toEqual([
      "program 1 [256:h264 257:0x0f 300:0x06]",
    ]);
    // With a second section in that packet, the layout is the later one's.
    const two = new TsTables();
    feed(two, pat);
    const told = feed(two, packets(pmtSection(1, HEVC)));
    expect(told.map((layout) => describeLayout(layout))).toEqual(["program 1 [211:hevc 221:0x0f]"]);
  });

  it("follows a PMT that moves to another PID", () => {
    const tables = new TsTables();
    feed(tables, tablePackets(H264, 0x10_00));
    // The PAT points elsewhere: what the old PMT said no longer counts, and its PID carries no tables.
    expect(feed(tables, patPackets([[1, 0x10_10]], 1))).toEqual([]);
    expect(tables.carriesTables(0x10_00)).toBe(false);
    expect(feed(tables, pmtPackets(HEVC, 1))).toEqual([]);
    const [layout] = feed(tables, pmtPackets(H264, 0, 0x10_10));
    expect(layout?.programs[0]?.pmtPid).toBe(0x10_10);
    expect(layout?.key).not.toBe(feed(new TsTables(), tablePackets(H264, 0x10_00))[0]?.key);
  });

  it("waits for every program's table before it tells of a stream with several", () => {
    const tables = new TsTables();
    const pat = patPackets([
      [1, 0x10_00],
      [2, 0x10_01],
      [0, 0x00_10],
    ]);
    expect(feed(tables, pat, pmtPackets(H264))).toEqual([]);
    const [layout] = feed(tables, pmtPackets(MOVED, 0, 0x10_01, 2));
    expect(describeLayout(layout!)).toBe("program 1 [256:h264 257:0x0f]; program 2 [211:h264 221:0x0f]");
  });

  it("goes on without the tables of programs that never come", () => {
    const tables = new TsTables();
    const pat = patPackets([
      [1, 0x10_00],
      [2, 0x10_01],
    ]);
    expect(feed(tables, pat, pmtPackets(H264))).toEqual([]);
    // The packet the patience ends on is a table's own: the next one of the stream settles it.
    expect(
      feed(
        tables,
        tsPackets(10_998),
        patPackets(
          [
            [1, 0x10_00],
            [2, 0x10_01],
          ],
          1,
        ),
      ),
    ).toEqual([]);
    const told = feed(tables, tsPackets(3));
    expect(told.map((layout) => describeLayout(layout))).toEqual(["program 1 [256:h264 257:0x0f]"]);
    // The late one is a change like any other.
    expect(feed(tables, pmtPackets(MOVED, 0, 0x10_01, 2))).toHaveLength(1);
  });

  it("writes its tables out as packets that a new reader learns the same layout from", () => {
    const long = [...HEVC, { pid: 300, type: 0x06, descriptors: Array.from({ length: 250 }, (_, index) => index) }];
    const tables = new TsTables();
    expect(tables.tablePackets()).toHaveLength(0);
    feed(tables, tablePackets(long, 0x10_00, 9));
    const written = tables.tablePackets();
    expect(written.length % 188).toBe(0);
    const [layout] = feed(new TsTables(), written);
    expect(layout?.key).toBe(tables.layout?.key);
    // They are packets in sync, one after the other, as the stream's own.
    const packets = new TsPackets();
    let seen = 0;
    packets.push(concatBytes(written, tsPackets(5)), () => {
      seen += 1;
    });
    expect(seen).toBe(written.length / 188 + 5);
  });

  it("names the codec of the video it knows, by stream type or registration", () => {
    expect(codec(0x1b)).toBe("h264");
    expect(codec(0x24)).toBe("hevc");
    expect(codec(0x02)).toBe("mpeg2video");
    expect(codec(0x0f)).toBeUndefined();
    expect(codec(0x06, registration("HEVC"))).toBe("hevc");
    expect(codec(0x06, registration("AV01"))).toBe("av1");
    expect(codec(0x06, registration("AC-3"))).toBeUndefined();
    expect(codec(0x06)).toBeUndefined();
    // A stream nothing is known of leaves the layout without a video codec.
    const [layout] = feed(
      new TsTables(),
      tablePackets([
        { pid: 400, type: 0x06 },
        { pid: 401, type: 0x0f },
      ]),
    );
    expect(videoCodecOfLayout(layout!)).toBeUndefined();
  });
});

describe("LayoutChanges", () => {
  it("takes the first layout for no change, and tells of each later one once", () => {
    const changes = new LayoutChanges();
    const push = (bytes: Uint8Array): void => {
      for (let at = 0; at < bytes.length; at += 188) {
        changes.packet(bytes, at);
      }
    };
    push(concatBytes(REAL_TABLES.pat, REAL_TABLES.h264, tsPackets(3)));
    expect(changes.changed()).toBe(false);
    push(concatBytes(REAL_TABLES.pat, REAL_TABLES.h264));
    expect(changes.changed()).toBe(false);
    push(concatBytes(REAL_TABLES.pat, REAL_TABLES.hevc));
    expect(changes.changed()).toBe(true);
    expect(changes.changed()).toBe(false);
  });
});
