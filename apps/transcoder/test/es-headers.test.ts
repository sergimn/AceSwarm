import { describe, expect, it } from "vitest";
import {
  audioSettings,
  packetParts,
  pesStart,
  shiftPcr,
  shiftPes,
  streamKind,
  tsAdd,
  tsDiff,
  videoStart,
} from "../src/es-headers.ts";
import {
  adtsFrame,
  bytesOf,
  H264_SETS,
  h264Unit,
  HEVC_SETS,
  hevcUnit,
  nalUnits,
  readPackets,
  RECOVERY_POINT,
  SETS,
  TsWriter,
} from "./es-fixtures.ts";
import type { StreamEntry } from "../src/ts-tables.ts";
import { concatBytes, sectionPackets, patSection } from "./ts-fixtures.ts";

const WRAP = 2 ** 33;

/** A program table's entry for a stream of this type, with these descriptor bytes. */
const entry = (type: number, descriptors: number[] = []): StreamEntry => ({
  pid: 256,
  type,
  descriptors: Uint8Array.from(descriptors),
});

/** The settings of the audio frame that is all of `frame`. */
const of = (format: "adts" | "mpeg" | "ac3", frame: Uint8Array): string | undefined =>
  audioSettings(format, frame, 0, frame.length);

/** Parameter sets as `videoStart` names them. */
const settingsOf = (sets: readonly string[]): string => sets.join(",");

/** The start of a unit of sound shown at 9000, read from a header whose byte `index` was set to `value`. */
function changed(index: number, value: number): ReturnType<typeof pesStart> {
  const packet = new TsWriter().pes(256, "audio", adtsFrame(), { pts: 9000 });
  const parts = packetParts(packet, 0);
  packet[parts.payloadAt + index] = value;
  return pesStart(packet, 0, parts);
}

/** Whether a picture coded by itself counts as one to start at, with these NAL units in front of it. */
const marked = (...units: string[]): boolean | undefined =>
  videoStart("h264", h264Unit("i", [...H264_SETS, ...units]), false)?.key;

describe("MPEG-TS timestamps", () => {
  it("tells which of two is later across the wrap", () => {
    expect(tsDiff(1000, 400)).toBe(600);
    expect(tsDiff(400, 1000)).toBe(-600);
    // 26 hours in, the 33 bits start over: a little after the wrap is later than a little before it.
    expect(tsDiff(500, WRAP - 500)).toBe(1000);
    expect(tsDiff(WRAP - 500, 500)).toBe(-1000);
  });

  it("moves one either way within its 33 bits", () => {
    expect(tsAdd(1000, 500)).toBe(1500);
    expect(tsAdd(WRAP - 100, 300)).toBe(200);
    expect(tsAdd(100, -300)).toBe(WRAP - 200);
  });
});

describe("the parts of a packet", () => {
  it("finds the payload behind the header, or behind an adaptation field", () => {
    const writer = new TsWriter();
    // Two packets: the first is full, the second is padded with an adaptation field.
    const packets = writer.pes(256, "video", new Uint8Array(200).fill(1), { pts: 9000 });
    expect(packetParts(packets, 0)).toEqual({ unitStart: true, payloadAt: 4, adaptationAt: -1 });
    const second = packetParts(packets, 188);
    expect(second.unitStart).toBe(false);
    expect(second.adaptationAt).toBe(188 + 5);
    // The payload is what is left of the 200 bytes and the 14-byte PES header after the first packet's 184.
    expect(188 + 188 - second.payloadAt).toBe(200 + 14 - 184);
  });

  it("finds none in a packet that only carries a clock reference", () => {
    const packet = new TsWriter().clock(256, 1234);
    expect(packetParts(packet, 0)).toEqual({ unitStart: false, payloadAt: -1, adaptationAt: 5 });
  });
});

describe("the start of a PES packet", () => {
  it("reads when a unit is shown, and when it is decoded where that differs", () => {
    const writer = new TsWriter();
    const shown = writer.pes(256, "video", h264Unit("p"), { pts: 123_456 });
    const start = pesStart(shown, 0, packetParts(shown, 0));
    expect(start).toMatchObject({ pts: 123_456, dts: undefined });
    // The stream's own bytes begin with the access unit delimiter.
    expect([...shown.subarray(start!.dataAt, start!.dataAt + 6)]).toEqual([0, 0, 0, 1, 0x09, 0xf0]);

    const reordered = writer.pes(256, "video", h264Unit("p"), { pts: 2 ** 32 + 7200, dts: 2 ** 32 + 3600 });
    expect(pesStart(reordered, 0, packetParts(reordered, 0))).toMatchObject({
      pts: 2 ** 32 + 7200,
      dts: 2 ** 32 + 3600,
    });
  });

  it("is none for a packet in the middle of a unit, or one that starts a table", () => {
    const packets = new TsWriter().pes(256, "video", h264Unit("p", [], 400), { pts: 9000 });
    expect(pesStart(packets, 188, packetParts(packets, 188))).toBeUndefined();
    const table = sectionPackets(0, patSection([[1, 4096]]));
    expect(pesStart(table, 0, packetParts(table, 0))).toBeUndefined();
  });

  it("is none for stream ids that carry no timestamps (padding, private data)", () => {
    const packet = new TsWriter().pes(256, "audio", adtsFrame(), { pts: 9000 });
    const parts = packetParts(packet, 0);
    expect(pesStart(packet, 0, parts)).toBeDefined();
    // 0xbe is a padding stream: what follows its length is no header.
    packet[parts.payloadAt + 3] = 0xbe;
    expect(pesStart(packet, 0, parts)).toBeUndefined();
  });

  it("is none for a header that can't hold what it says it has, or that is of the older kind", () => {
    // Unchanged, it reads; its fields are five bytes, the time the unit is shown.
    expect(changed(8, 5)).toMatchObject({ pts: 9000 });
    // The header says it has a time, and has four bytes of fields.
    expect(changed(8, 4)).toBeUndefined();
    // Its fields would end behind the packet.
    expect(changed(8, 200)).toBeUndefined();
    // An MPEG-1 packet has no flags where MPEG-2 has its two marker bits.
    expect(changed(6, 0x21)).toBeUndefined();
    // Flags that name a time to decode without a time to show are not allowed: neither is read.
    expect(changed(7, 0x40)).toMatchObject({ pts: undefined, dts: undefined });
  });

  it("moves a unit's times in place, across the wrap too", () => {
    const writer = new TsWriter();
    const packet = writer.pes(256, "video", h264Unit("p"), { pts: WRAP - 1000, dts: WRAP - 4600 });
    const before = Uint8Array.from(packet);
    shiftPes(packet, pesStart(packet, 0, packetParts(packet, 0))!, 3000);
    const [seen] = readPackets(packet);
    expect(seen).toMatchObject({ pts: 2000, dts: WRAP - 1600 });
    // Nothing but the ten timestamp bytes changed, and their marker bits are as they were.
    const changed = packet.keys().filter((index) => packet[index] !== before[index]);
    expect(changed.every((index) => index >= 13 && index < 23)).toBe(true);
    for (const index of [13, 15, 17, 18, 20, 22]) {
      expect((packet[index] ?? 0) & 1).toBe(1);
    }
    expect((packet[13] ?? 0) >> 4).toBe(3);
    expect((packet[18] ?? 0) >> 4).toBe(1);
  });
});

describe("a packet's clock reference", () => {
  it("is moved in place, and its 27 MHz part stays", () => {
    const writer = new TsWriter();
    const packet = writer.pes(256, "video", h264Unit("p"), { pts: 9000, pcr: WRAP - 500 });
    // The extension's nine bits: the fixture writes 0, so set some to see that they stay.
    packet[10] = (packet[10] ?? 0) | 0x01;
    packet[11] = 0x2a;
    shiftPcr(packet, packetParts(packet, 0), 1500);
    const [seen] = readPackets(packet);
    expect(seen?.pcr).toBe(1000);
    // The clock's lowest bit, six reserved bits and the extension's highest; then its other eight.
    expect([...packet.subarray(10, 12)]).toEqual([0x7f, 0x2a]);
    // The unit's own times are not the clock's business.
    expect(seen?.pts).toBe(9000);
  });

  it("is left alone where a packet has none", () => {
    const writer = new TsWriter();
    const packets = concatBytes(
      writer.pes(256, "video", h264Unit("p"), { pts: 9000 }),
      writer.pes(256, "video", h264Unit("p"), { pts: 9000, discontinuity: true }),
    );
    const before = Uint8Array.from(packets);
    for (let at = 0; at < packets.length; at += 188) {
      shiftPcr(packets, packetParts(packets, at), 1500);
    }
    expect(packets).toEqual(before);
  });

  it("is left alone in a field too short to hold one, whatever its flags say", () => {
    const packet = new TsWriter().pes(256, "video", h264Unit("p"), { pts: 9000, pcr: 123_456 });
    // A damaged packet: the field says it has a clock reference, in three bytes.
    packet[4] = 3;
    const before = Uint8Array.from(packet);
    shiftPcr(packet, packetParts(packet, 0), 1500);
    expect(packet).toEqual(before);
  });
});

describe("what kind of stream a table entry is", () => {
  it("knows the video and audio whose decoder settings can be read", () => {
    expect(streamKind(entry(0x1b))).toEqual({ kind: "video", codec: "h264" });
    expect(streamKind(entry(0x24))).toEqual({ kind: "video", codec: "hevc" });
    expect(streamKind(entry(0x0f))).toEqual({ kind: "audio", format: "adts" });
    expect(streamKind(entry(0x03))).toEqual({ kind: "audio", format: "mpeg" });
    expect(streamKind(entry(0x04))).toEqual({ kind: "audio", format: "mpeg" });
    expect(streamKind(entry(0x81))).toEqual({ kind: "audio", format: "ac3" });
    // AC-3 as DVB carries it: private data with an AC-3 descriptor.
    expect(streamKind(entry(0x06, [0x6a, 0x01, 0x00]))).toEqual({ kind: "audio", format: "ac3" });
  });

  it("takes subtitles and other data for streams no decoder reads", () => {
    // DVB subtitles: private data with a subtitling descriptor.
    expect(streamKind(entry(0x06, [0x59, 0x08, 0x65, 0x6e, 0x67, 0x10, 0x00, 0x01, 0x00, 0x01]))).toEqual({
      kind: "other",
    });
    // SCTE-35 cue messages.
    expect(streamKind(entry(0x86))).toEqual({ kind: "other" });
  });

  it("knows nothing of video and audio it can't check", () => {
    // MPEG-2 video, AAC in LATM, DTS by its descriptor, and a type nobody registered.
    expect(streamKind(entry(0x02))).toBeUndefined();
    expect(streamKind(entry(0x11))).toBeUndefined();
    expect(streamKind(entry(0x06, [0x7b, 0x01, 0x00]))).toBeUndefined();
    expect(streamKind(entry(0xa1))).toBeUndefined();
  });
});

describe("an audio frame's settings", () => {
  it("are the same for AAC frames that differ in length or private bit, and differ with the channels or the rate", () => {
    const base = of("adts", adtsFrame());
    expect(base).toBeDefined();
    expect(of("adts", adtsFrame({ privateBit: true }))).toBe(base);
    const longer = adtsFrame();
    longer[4] = (longer[4] ?? 0) + 1;
    expect(of("adts", longer)).toBe(base);
    expect(of("adts", adtsFrame({ channels: 2 }))).not.toBe(base);
    expect(of("adts", adtsFrame({ rateIndex: 4 }))).not.toBe(base);
  });

  it("are read from an MPEG audio header: bitrate and rate count, padding does not", () => {
    // MPEG-1 layer II, 192 kbit/s, 48 kHz, stereo; the same with the padding bit; the same at 44.1 kHz.
    const base = of("mpeg", bytesOf("fffda400"));
    expect(base).toBeDefined();
    expect(of("mpeg", bytesOf("fffda600"))).toBe(base);
    expect(of("mpeg", bytesOf("fffda000"))).not.toBe(base);
    // Mono.
    expect(of("mpeg", bytesOf("fffda4c0"))).not.toBe(base);
  });

  it("are read from an AC-3 header: rate, frame size, version and mode", () => {
    // Sync word, CRC, then 48 kHz at 192 kbit/s, bitstream id 8, and the channel mode in the top bits.
    const base = of("ac3", bytesOf("0b77aabb14404000"));
    expect(base).toBeDefined();
    // Bits after the channel mode say other things (the centre mix level, say).
    expect(of("ac3", bytesOf("0b77ccdd14405f00"))).toBe(base);
    expect(of("ac3", bytesOf("0b77aabb1e404000"))).not.toBe(base);
    expect(of("ac3", bytesOf("0b77aabb1440e000"))).not.toBe(base);
  });

  it("are none where no frame header is", () => {
    expect(of("adts", bytesOf("0011223344556677"))).toBeUndefined();
    expect(of("mpeg", bytesOf("ff1da400"))).toBeUndefined();
    expect(of("ac3", bytesOf("0b78aabb14404000"))).toBeUndefined();
    // Too short to tell.
    expect(of("adts", bytesOf("fff1"))).toBeUndefined();
    expect(of("ac3", bytesOf("0b77aabb1440"))).toBeUndefined();
  });
});

describe("how an access unit of video starts", () => {
  it("reads the decoder settings in front of a picture a decoder can start at", () => {
    expect(videoStart("h264", h264Unit("idr", H264_SETS), false)).toEqual({
      settings: settingsOf(H264_SETS),
      key: true,
    });
    expect(videoStart("hevc", hevcUnit("hevcIdr", HEVC_SETS), false)).toEqual({
      settings: settingsOf(HEVC_SETS),
      key: true,
    });
  });

  it("finds none in front of a picture that needs earlier ones", () => {
    expect(videoStart("h264", h264Unit("p"), false)).toEqual({ settings: "", key: false });
    expect(videoStart("hevc", hevcUnit("hevcTrail"), false)).toEqual({ settings: "", key: false });
  });

  it("takes a picture coded by itself for one to start at where the stream marks it, as encoders without IDR pictures send them", () => {
    const settings = settingsOf(H264_SETS);
    expect(videoStart("h264", h264Unit("intra", H264_SETS), false)).toEqual({ settings, key: true });
    // Coded by itself and not marked: what follows it may still need what came before it.
    expect(videoStart("h264", h264Unit("i", H264_SETS), false)).toEqual({ settings, key: false });
    // The mark in front of a picture that needs earlier ones (an encoder that renews the picture
    // bit by bit): the pictures only come right some time after it.
    const renewing = h264Unit("p", [...H264_SETS, RECOVERY_POINT]);
    expect(videoStart("h264", renewing, false)).toEqual({ settings, key: false });
    // The same settings in front of a picture that is neither: no place to start.
    expect(videoStart("h264", h264Unit("p", H264_SETS), false)).toEqual({ settings, key: false });
  });

  it("finds the mark of a point to start at among the other messages encoders send with it", () => {
    // Behind a message of three bytes.
    expect(marked("060003aabbcc0601c480")).toBe(true);
    // Behind one whose size takes two bytes (255 and 1).
    expect(marked(`0605ff01${"a5".repeat(256)}0601c480`)).toBe(true);
    // Behind one whose type takes two bytes; that one (255 and 6) is not the mark.
    expect(marked("06ff0601aa0601c480")).toBe(true);
    expect(marked("06ff0601aa80")).toBe(false);
    // Behind one whose bytes have 00 00 01, which the stream writes as 00 00 03 01: the 03 is not counted.
    expect(marked("06050400000301ee0601c480")).toBe(true);
    // Bytes of another message that look like the mark are none.
    expect(marked("060102060180")).toBe(false);
    // In the second of two such units.
    expect(marked("060003aabbcc80", RECOVERY_POINT)).toBe(true);
    // The same bytes in a unit of another kind (filler data) say nothing.
    expect(marked("0c0601c480")).toBe(false);
  });

  it("takes every kind of HEVC random access picture for one to start at, and no other picture", () => {
    expect(videoStart("hevc", hevcUnit("hevcCra", HEVC_SETS), false)).toEqual({
      settings: settingsOf(HEVC_SETS),
      key: true,
    });
    const keyOf = (type: number): boolean | undefined => {
      const slice = concatBytes(bytesOf("000001"), Uint8Array.of(type << 1, 0x01, 0xaf), new Uint8Array(50).fill(0xa5));
      return videoStart("hevc", concatBytes(nalUnits("460150", ...HEVC_SETS), slice), false)?.key;
    };
    // Types 16 to 23 are the random access pictures; 15 and 24 are next to them.
    expect([15, 16, 23, 24].map((type) => keyOf(type))).toEqual([false, true, true, false]);
  });

  it("tells other settings apart", () => {
    const small = videoStart("h264", h264Unit("idr", [SETS.smallSps, SETS.pps]), false);
    expect(small?.settings).toBe(settingsOf([SETS.smallSps, SETS.pps]));
    expect(small?.settings).not.toBe(settingsOf(H264_SETS));
  });

  it("does not count the zeros some encoders put behind a parameter set", () => {
    const padded = concatBytes(
      nalUnits("09f0", SETS.sps),
      bytesOf("0000"),
      nalUnits(SETS.pps),
      bytesOf("00"),
      bytesOf("000001658884"),
      new Uint8Array(50).fill(0xa5),
    );
    expect(videoStart("h264", padded, false)).toEqual({ settings: settingsOf(H264_SETS), key: true });
  });

  it("waits for more while the picture has not begun, and makes do with what there is once no more comes", () => {
    const unit = h264Unit("idr", H264_SETS);
    // Cut in the middle of the second parameter set.
    const cut = unit.subarray(0, nalUnits("09f0", SETS.sps).length + 6);
    expect(videoStart("h264", cut, false)).toBeUndefined();
    // A set that may be cut short doesn't count, so neither do the settings as a whole.
    expect(videoStart("h264", cut, true)).toEqual({ settings: "", key: false });
    // Cut right behind the picture's start code and NAL header: the kind of picture isn't there yet.
    const atPicture = unit.subarray(0, nalUnits("09f0", ...H264_SETS).length + 4);
    expect(videoStart("h264", atPicture, false)).toBeUndefined();
  });

  it("finds no settings without the one a decoder can't do without", () => {
    // Only a PPS in front of the picture, as some encoders repeat it with every picture.
    expect(videoStart("h264", h264Unit("p", [SETS.pps]), false)).toEqual({ settings: "", key: false });
  });
});
