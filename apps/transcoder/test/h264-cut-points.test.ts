import { describe, expect, it } from "vitest";
import { cutPointOf, type CutPoint } from "../src/h264-cut-points.ts";

const START = [0, 0, 0, 1];
const SHORT_START = [0, 0, 1];
const AUD = [0x09, 0xf0];
const SPS = [0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50];
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0];
const IDR = [0x65, 0x88, 0x84, 0x00, 0x33];
const SLICE = [0x41, 0x9a, 0x02, 0x0c];
const PARTITION_A = [0x22, 0x9a, 0x02];

/** Bits written most significant first, then the bit equal to one and zeros that end an SEI payload. */
function payloadOf(
  write: (bit: (value: number, count: number) => void, ue: (value: number) => void) => void,
): number[] {
  const bits: number[] = [];
  const bit = (value: number, count: number): void => {
    for (let index = count - 1; index >= 0; index -= 1) {
      bits.push(Math.floor(value / 2 ** index) % 2);
    }
  };
  const ue = (value: number): void => {
    const coded = value + 1;
    const length = Math.floor(Math.log2(coded)) + 1;
    bit(0, length - 1);
    bit(coded, length);
  };
  write(bit, ue);
  if (bits.length % 8 !== 0) {
    bits.push(1);
    while (bits.length % 8 !== 0) {
      bits.push(0);
    }
  }
  const bytes: number[] = [];
  for (let at = 0; at < bits.length; at += 8) {
    bytes.push(bits.slice(at, at + 8).reduce((value, one) => value * 2 + one, 0));
  }
  return bytes;
}

function recoveryPoint(frames: number): number[] {
  return payloadOf((bit, ue) => {
    ue(frames);
    bit(0, 4); // exact_match_flag, broken_link_flag, changing_slice_group_idc
  });
}

/** A buffering period's payload as far as ffmpeg reads it without the SPS: the SPS's number. */
function bufferingPeriod(sps: number): number[] {
  return payloadOf((_bit, ue) => {
    ue(sps);
  });
}

/** A payload of that many bytes, for a message whose content doesn't matter. */
function bytes(length: number): number[] {
  return Array.from({ length }, () => 7);
}

/** A payload type or size as SEI writes it: 0xFF bytes for each 255, then the rest. */
function sizeOf(value: number): number[] {
  return [...Array.from({ length: Math.floor(value / 255) }, () => 0xff), value % 255];
}

/** An SEI NAL unit (with the RBSP stop bit) holding the messages, with emulation prevention as an encoder adds it. */
function sei(...messages: { type: number; payload: number[] }[]): number[] {
  const rbsp = [
    ...messages.flatMap(({ type, payload }) => [...sizeOf(type), ...sizeOf(payload.length), ...payload]),
    0x80,
  ];
  const out = [0x06];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out;
}

function unit(...nals: number[][]): Uint8Array {
  return Uint8Array.from(nals.flatMap((nal) => [...START, ...nal]));
}

const BUFFERING_PERIOD = 0;
const PIC_TIMING = 1;
const REGISTERED = 4;
const UNREGISTERED = 5;
const RECOVERY_POINT = 6;
const MASTERING_DISPLAY = 137;
/** User data longer than 255 bytes, so that its size takes two bytes. */
const USER_DATA = Array.from({ length: 300 }, (_, index) => index % 7);
/** An SEI unit with a recovery point after which the frame is whole at once (no frames to wait for). */
const POINT_SEI = sei({ type: RECOVERY_POINT, payload: recoveryPoint(0) });
/** An SEI unit with a recovery point at the most frames ffmpeg allows, and one with a frame more. */
const LATEST_POINT_SEI = sei({ type: RECOVERY_POINT, payload: recoveryPoint(65_535) });
const TOO_LATE_POINT_SEI = sei({ type: RECOVERY_POINT, payload: recoveryPoint(65_536) });

describe("cutPointOf", () => {
  it("cuts at an IDR slice, with or without parameter sets before it", () => {
    expect(cutPointOf(unit(AUD, SPS, PPS, IDR))).toBe("idr");
    expect(cutPointOf(unit(IDR))).toBe("idr");
    // With a recovery point too, it is an IDR picture all the same.
    expect(cutPointOf(unit(AUD, POINT_SEI, IDR))).toBe("idr");
    expect(cutPointOf(Uint8Array.from([...SHORT_START, ...AUD, ...SHORT_START, ...IDR]))).toBe("idr");
  });

  it("does not cut at a slice that no recovery point comes before, I slice or not", () => {
    expect(cutPointOf(unit(AUD, SLICE))).toBe("none");
    // An I slice in a stream with several reference frames: ffmpeg's parser flags none of it.
    expect(cutPointOf(unit(AUD, SPS, PPS, [0x61, 0x88, 0x80]))).toBe("none");
  });

  it("cuts at a slice after a recovery point, also after other messages", () => {
    expect(cutPointOf(unit(AUD, POINT_SEI, SLICE))).toBe("recovery-point");
    const timing = { type: PIC_TIMING, payload: [0x00, 0x00, 0x08, 0x10] };
    const userData = { type: UNREGISTERED, payload: USER_DATA };
    const point = { type: RECOVERY_POINT, payload: recoveryPoint(3) };
    const together = sei(timing, userData, point);
    expect(cutPointOf(unit(AUD, together, SLICE))).toBe("recovery-point");
    const apart = [sei(timing), sei(point)];
    expect(cutPointOf(unit(AUD, ...apart, SLICE))).toBe("recovery-point");
  });

  it("does not cut at a data partition: ffmpeg's parser takes it for no slice", () => {
    expect(cutPointOf(unit(AUD, POINT_SEI, PARTITION_A))).toBe("none");
  });

  it("takes no recovery point after a message ffmpeg refuses in the same SEI unit, where it stops reading", () => {
    const point = { type: RECOVERY_POINT, payload: recoveryPoint(0) };
    const after = (type: number, payload: number[]): CutPoint | undefined =>
      cutPointOf(unit(AUD, sei({ type, payload }, point), SLICE));
    // User data with less than its UUID.
    expect(after(UNREGISTERED, bytes(4))).toBe("none");
    expect(after(UNREGISTERED, bytes(16))).toBe("recovery-point");
    // Picture timing longer than ffmpeg keeps.
    expect(after(PIC_TIMING, bytes(41))).toBe("none");
    expect(after(PIC_TIMING, bytes(40))).toBe("recovery-point");
    // A buffering period for an SPS number that can't be.
    expect(after(BUFFERING_PERIOD, bufferingPeriod(35))).toBe("none");
    // Read as 31, which may be an SPS the stream doesn't have: ffmpeg reads on all the same.
    expect(after(BUFFERING_PERIOD, bufferingPeriod(34))).toBe("recovery-point");
    // Too short a mastering display colour volume.
    expect(after(MASTERING_DISPLAY, bytes(23))).toBe("none");
    expect(after(MASTERING_DISPLAY, bytes(24))).toBe("recovery-point");
    // Captions: whether ffmpeg reads them goes deeper than their size, so they count as refused.
    expect(after(REGISTERED, [0xb5, 0x00, 0x31, 0x47, 0x41, 0x39, 0x34, 0x03, 0x00, 0xff])).toBe("none");
    // A type ffmpeg doesn't read is skipped.
    expect(after(200, bytes(3))).toBe("recovery-point");
    // In an SEI unit of its own, a refused message takes nothing from the recovery point.
    const apart = unit(AUD, sei({ type: UNREGISTERED, payload: bytes(4) }), sei(point), SLICE);
    expect(cutPointOf(apart)).toBe("recovery-point");
    // Nor does one after it.
    const later = unit(AUD, sei(point, { type: UNREGISTERED, payload: bytes(1) }), SLICE);
    expect(cutPointOf(later)).toBe("recovery-point");
  });

  it("reads the messages without the bytes that prevent start codes in them", () => {
    // Zeros in the user data make the encoder add 03 bytes; counted as payload they would shift
    // every message after them.
    const userData = { type: UNREGISTERED, payload: [0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 9, 9, 9, 9, 9] };
    const nal = sei(userData, { type: RECOVERY_POINT, payload: recoveryPoint(0) });
    // Four added, and one of the user data's own.
    expect(nal.filter((byte) => byte === 3)).toHaveLength(5);
    expect(cutPointOf(unit(AUD, nal, SLICE))).toBe("recovery-point");
  });

  it("takes a recovery point only as ffmpeg does: within the frame numbers it allows, and in a whole message", () => {
    expect(cutPointOf(unit(LATEST_POINT_SEI, SLICE))).toBe("recovery-point");
    expect(cutPointOf(unit(TOO_LATE_POINT_SEI, SLICE))).toBe("none");
    // A message that says it is longer than what the unit has left: ffmpeg stops reading there.
    const cut = [...POINT_SEI];
    cut[2] = 9;
    expect(cutPointOf(unit(cut, SLICE))).toBe("none");
  });

  it("tells nothing until the first slice: a unit cut off before it is undecided", () => {
    expect(cutPointOf(unit(AUD, SPS, PPS))).toBeUndefined();
    expect(cutPointOf(unit(AUD, POINT_SEI))).toBeUndefined();
    expect(cutPointOf(Uint8Array.from([0, 0]))).toBeUndefined();
    expect(cutPointOf(new Uint8Array(0))).toBeUndefined();
  });

  it("forgets nothing between units: a recovery point counts only for the slice of its own unit", () => {
    // Each call is one access unit, as ffmpeg's parser starts afresh with every frame.
    expect(cutPointOf(unit(POINT_SEI, SLICE))).toBe("recovery-point");
    expect(cutPointOf(unit(SLICE))).toBe("none");
  });
});
