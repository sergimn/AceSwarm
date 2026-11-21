import { PACKET_BYTES } from "./ts-packets.ts";
import { formatOf, videoCodecOf, type StreamEntry } from "./ts-tables.ts";

/** MPEG-TS timestamps count 90 kHz ticks in 33 bits, and wrap after about 26 hours. */
const TS_WRAP = 2 ** 33;
const TOP_BITS = 2 ** 30;

/** `a - b` in ticks, the short way around the wrap: positive when `a` is the later one. */
export function tsDiff(a: number, b: number): number {
  const diff = (((a - b) % TS_WRAP) + TS_WRAP) % TS_WRAP;
  return diff >= TS_WRAP / 2 ? diff - TS_WRAP : diff;
}

/** `ts` moved by `ticks` (either way), within the 33 bits. */
export function tsAdd(ts: number, ticks: number): number {
  return (((ts + ticks) % TS_WRAP) + TS_WRAP) % TS_WRAP;
}

/** Where the parts of one packet are; every position is an index into the packet's buffer. */
export interface PacketParts {
  /** A unit (a PES packet, or a table section) starts in this packet. */
  unitStart: boolean;
  /** The first byte of the payload; -1 for a packet that has none (or a damaged one). */
  payloadAt: number;
  /** The adaptation field's flags byte; -1 without one. */
  adaptationAt: number;
}

export function packetParts(data: Uint8Array, at: number): PacketParts {
  const control = ((data[at + 3] ?? 0) >> 4) & 0x03;
  const adaptation = (control & 0x02) !== 0;
  const length = adaptation ? (data[at + 4] ?? 0) : 0;
  const payloadAt = at + 4 + (adaptation ? 1 + length : 0);
  return {
    unitStart: ((data[at + 1] ?? 0) & 0x40) !== 0,
    payloadAt: (control & 0x01) !== 0 && payloadAt < at + PACKET_BYTES ? payloadAt : -1,
    adaptationAt: adaptation && length > 0 ? at + 5 : -1,
  };
}

/** A PES timestamp: 33 bits in 5 bytes, between marker bits. */
function readTimestamp(data: Uint8Array, at: number): number {
  const top = ((data[at] ?? 0) >> 1) & 0x07;
  const low =
    ((data[at + 1] ?? 0) << 22) |
    (((data[at + 2] ?? 0) >> 1) << 15) |
    ((data[at + 3] ?? 0) << 7) |
    ((data[at + 4] ?? 0) >> 1);
  return top * TOP_BITS + low;
}

function writeTimestamp(data: Uint8Array, at: number, ts: number): void {
  const top = Math.floor(ts / TOP_BITS);
  const low = ts - top * TOP_BITS;
  data[at] = ((data[at] ?? 0) & 0xf1) | (top << 1);
  data[at + 1] = (low >>> 22) & 0xff;
  data[at + 2] = ((data[at + 2] ?? 0) & 0x01) | (((low >>> 15) & 0x7f) << 1);
  data[at + 3] = (low >>> 7) & 0xff;
  data[at + 4] = ((data[at + 4] ?? 0) & 0x01) | ((low & 0x7f) << 1);
}

/** The start of a PES packet (one access unit of video, or some frames of audio), as far as its first packet tells. */
export interface PesStart {
  /** When it is shown, and when it is decoded where that differs (video with B-frames). */
  pts: number | undefined;
  dts: number | undefined;
  /** Where the elementary stream's own bytes begin. */
  dataAt: number;
  ptsAt: number;
  dtsAt: number;
}

/** PES stream ids whose packets have no header fields after the length: no timestamps, no stream of frames. */
const PLAIN_STREAM_IDS = new Set([0xbc, 0xbe, 0xbf, 0xf0, 0xf1, 0xf2, 0xf8, 0xff]);

/** Whether a PES packet with header fields (timestamps among them) starts at `start`. */
function startsPes(data: Uint8Array, start: number): boolean {
  const streamId = data[start + 3] ?? 0;
  const prefixed = data[start] === 0 && data[start + 1] === 0 && data[start + 2] === 1;
  return prefixed && streamId >= 0xbc && !PLAIN_STREAM_IDS.has(streamId) && ((data[start + 6] ?? 0) & 0xc0) === 0x80;
}

/**
 * Reads the PES header that starts at a packet's payload. Undefined when the payload starts with
 * something else (a table section, say), or when the header doesn't fit in this one packet, which
 * muxers avoid.
 */
export function pesStart(data: Uint8Array, at: number, parts: PacketParts): PesStart | undefined {
  const start = parts.payloadAt;
  const end = at + PACKET_BYTES;
  if (!parts.unitStart || start < 0 || start + 9 > end || !startsPes(data, start)) {
    return undefined;
  }
  const flags = (data[start + 7] ?? 0) >> 6;
  const headerBytes = data[start + 8] ?? 0;
  const hasPts = (flags & 0x02) !== 0;
  const hasDts = flags === 3;
  const dataAt = start + 9 + headerBytes;
  if (dataAt > end || headerBytes < (hasPts ? 5 : 0) + (hasDts ? 5 : 0)) {
    return undefined;
  }
  return {
    pts: hasPts ? readTimestamp(data, start + 9) : undefined,
    dts: hasDts ? readTimestamp(data, start + 14) : undefined,
    dataAt,
    ptsAt: hasPts ? start + 9 : -1,
    dtsAt: hasDts ? start + 14 : -1,
  };
}

/** Moves the timestamps of a PES header by `ticks`, in place. */
export function shiftPes(data: Uint8Array, pes: PesStart, ticks: number): void {
  if (pes.pts !== undefined) {
    writeTimestamp(data, pes.ptsAt, tsAdd(pes.pts, ticks));
  }
  if (pes.dts !== undefined) {
    writeTimestamp(data, pes.dtsAt, tsAdd(pes.dts, ticks));
  }
}

const PCR_FLAG = 0x10;
const PCR_LOW_BITS = 2 ** 25;

/** Moves the clock reference (PCR) a packet's adaptation field may carry by `ticks`, in place. */
export function shiftPcr(data: Uint8Array, parts: PacketParts, ticks: number): void {
  const flagsAt = parts.adaptationAt;
  if (flagsAt < 0 || ((data[flagsAt] ?? 0) & PCR_FLAG) === 0 || (data[flagsAt - 1] ?? 0) < 7) {
    return;
  }
  // 33 bits of 90 kHz ticks, 6 reserved bits, then 9 bits of 27 MHz that stay as they are.
  const at = flagsAt + 1;
  const base =
    (data[at] ?? 0) * PCR_LOW_BITS +
    (((data[at + 1] ?? 0) << 17) |
      ((data[at + 2] ?? 0) << 9) |
      ((data[at + 3] ?? 0) << 1) |
      ((data[at + 4] ?? 0) >> 7));
  const moved = tsAdd(base, ticks);
  const high = Math.floor(moved / PCR_LOW_BITS);
  const low = moved - high * PCR_LOW_BITS;
  data[at] = high;
  data[at + 1] = (low >>> 17) & 0xff;
  data[at + 2] = (low >>> 9) & 0xff;
  data[at + 3] = (low >>> 1) & 0xff;
  data[at + 4] = ((data[at + 4] ?? 0) & 0x7f) | ((low & 0x01) << 7);
}

/**
 * What a stream is, as far as carrying a decoder over to another PID goes:
 * - video and audio whose decoder settings can be read from the stream itself, and so compared;
 * - "other": subtitles, teletext, cue messages and the like, which no decoder here reads (the
 *   streams `formatOf` leaves out of a layout).
 * Undefined for anything else: audio or video that can't be checked, or a kind not known here.
 */
export type StreamKind =
  { kind: "video"; codec: "h264" | "hevc" } | { kind: "audio"; format: "adts" | "mpeg" | "ac3" } | { kind: "other" };

const AC3_DESCRIPTOR = 0x6a;

function hasDescriptor(descriptors: Uint8Array, wanted: number): boolean {
  for (let at = 0; at + 2 <= descriptors.length; at += 2 + (descriptors[at + 1] ?? 0)) {
    if (descriptors[at] === wanted) {
      return true;
    }
  }
  return false;
}

export function streamKind(entry: StreamEntry): StreamKind | undefined {
  if (formatOf(entry) === undefined) {
    return { kind: "other" };
  }
  const codec = videoCodecOf(entry);
  if (codec !== undefined) {
    return codec === "h264" || codec === "hevc" ? { kind: "video", codec } : undefined;
  }
  switch (entry.type) {
    case 0x0f: {
      return { kind: "audio", format: "adts" };
    }
    case 0x03:
    case 0x04: {
      return { kind: "audio", format: "mpeg" };
    }
    case 0x81: {
      return { kind: "audio", format: "ac3" };
    }
    case 0x06: {
      return hasDescriptor(entry.descriptors, AC3_DESCRIPTOR) ? { kind: "audio", format: "ac3" } : undefined;
    }
    default: {
      return undefined;
    }
  }
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("hex");

/**
 * What an audio decoder is set up with, from the header of the first frame at `at`: the format's
 * version and layer, the sample rate and the channels (and for MPEG audio and AC-3 the bitrate,
 * which is part of how their frames are cut). Undefined when no frame header is there.
 */
export function audioSettings(
  format: "adts" | "mpeg" | "ac3",
  data: Uint8Array,
  at: number,
  end: number,
): string | undefined {
  const byte = (index: number): number => data[at + index] ?? 0;
  if (format === "ac3") {
    const synced = end - at >= 7 && byte(0) === 0x0b && byte(1) === 0x77;
    return synced ? hex(Uint8Array.of(byte(4), byte(5), byte(6) & 0xe0)) : undefined;
  }
  if (end - at < 4 || byte(0) !== 0xff) {
    return undefined;
  }
  if (format === "adts") {
    // Sync, then ID, layer and protection; profile, sample rate and channels (not the private bit).
    return (byte(1) & 0xf6) === 0xf0 ? hex(Uint8Array.of(byte(1), byte(2) & 0xfd, byte(3) & 0xc0)) : undefined;
  }
  // Version, layer and protection; bitrate and sample rate (not padding); mono or stereo.
  return (byte(1) & 0xe0) === 0xe0 ? hex(Uint8Array.of(byte(1), byte(2) & 0xfc, byte(3) & 0xc0)) : undefined;
}

/** NAL unit types that set a decoder up: SPS, PPS, SPS extension and subset SPS; VPS, SPS and PPS. */
const SETTINGS_NALS = { h264: new Set([7, 8, 13, 15]), hevc: new Set([32, 33, 34]) };
/** The one a decoder can't do without. */
const SPS_NAL = { h264: 7, hevc: 33 };

/** The Exp-Golomb coded number (as H.264 writes its headers) that starts at bit `bit` of `data`, and where the next one starts. */
function expGolomb(data: Uint8Array, bit: number): { value: number; next: number } {
  const bitAt = (index: number): number => ((data[index >> 3] ?? 0) >> (7 - (index & 7))) & 1;
  let zeros = 0;
  while (zeros < 16 && bitAt(bit + zeros) === 0) {
    zeros += 1;
  }
  let value = 1;
  for (let index = 1; index <= zeros; index += 1) {
    value = value * 2 + bitAt(bit + zeros + index);
  }
  return { value: value - 1, next: bit + 2 * zeros + 1 };
}

/** What a NAL unit is: its type, whether it is a slice of a picture, and whether of one a decoder can start at. */
interface NalKind {
  type: number;
  picture: boolean;
  key: boolean;
  /** A picture coded by itself that is no IDR picture: one to start at only where the stream marks it as such (see `marksRecovery`). */
  intra: boolean;
}

/** What kind of NAL unit begins with the header at `at`. */
function nalKind(codec: "h264" | "hevc", head: Uint8Array, at: number): NalKind {
  const header = head[at] ?? 0;
  if (codec === "hevc") {
    // Types up to 31 are slices; 16 to 23 those of random access pictures (BLA, IDR, CRA).
    const type = (header >> 1) & 0x3f;
    return { type, picture: type <= 31, key: type >= 16 && type <= 23, intra: false };
  }
  const type = header & 0x1f;
  if (type !== 1) {
    // 5 is a slice of an IDR picture; 2 to 4 are parts of slices, which say less.
    return { type, picture: type >= 1 && type <= 5, key: type === 5, intra: false };
  }
  // Slice type I (2, or 7 for "all of the picture's slices").
  const sliceType = expGolomb(head, expGolomb(head, (at + 1) * 8).next).value;
  return { type, picture: true, key: false, intra: sliceType % 5 === 2 };
}

const H264_SEI_NAL = 6;
const RECOVERY_POINT_MESSAGE = 6;

/**
 * Whether an H.264 SEI NAL unit (`body` is what follows its header byte) has a recovery point
 * message: the encoder's word that a decoder can start at this picture. Encoders that send no
 * IDR pictures mark the pictures to start at this way.
 */
function marksRecovery(body: Uint8Array): boolean {
  // The messages' sizes count the bytes without the 03 that keeps 00 00 from looking like a start code.
  const bytes = body.filter((value, index) => value !== 3 || body[index - 1] !== 0 || body[index - 2] !== 0);
  let at = 0;
  // A number is the sum of its bytes, the last of which is the first below 255.
  const number = (): number => {
    let value = 0;
    while (bytes[at] === 0xff) {
      value += 0xff;
      at += 1;
    }
    at += 1;
    return value + (bytes[at - 1] ?? 0);
  };
  // After the last message comes one byte that ends the unit.
  while (at + 1 < bytes.length) {
    if (number() === RECOVERY_POINT_MESSAGE) {
      return true;
    }
    // A message's size comes after its type, and its bytes after that.
    const size = number();
    at += size;
  }
  return false;
}

/**
 * The NAL units in `head`, in order: where each one's header byte is and where it ends, at the
 * next start code (00 00 01; zeros in front of that belong to neither unit) or, for the last one,
 * with the bytes (`open`: more of it may still come).
 */
function* nalSpans(head: Uint8Array): Generator<{ at: number; end: number; open: boolean }> {
  let from = -1;
  for (let at = 0; at + 3 < head.length; at += 1) {
    if (head[at] !== 0 || head[at + 1] !== 0 || head[at + 2] !== 1) {
      continue;
    }
    if (from >= 0) {
      yield { at: from, end: at, open: false };
    }
    from = at + 3;
    at += 2;
  }
  if (from >= 0) {
    yield { at: from, end: head.length, open: true };
  }
}

function withoutTrailingZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }
  return bytes.subarray(0, end);
}

/** How an access unit of video starts. */
export interface VideoStart {
  /** What a decoder is set up with (the parameter sets it carries), as one string; "" if it has none. */
  settings: string;
  /**
   * Whether its picture is one a decoder can start at: an IDR picture; in H.264 also a picture
   * coded by itself that the stream marks as a point to start at (a recovery point), as encoders
   * without IDR pictures send them; in HEVC any random access picture. Only after an IDR picture
   * is every picture that follows sure to need nothing from before it: after the others, the
   * few that are shown before the start but come after it in the stream may show damaged.
   */
  key: boolean;
}

/**
 * Reads how an access unit of video starts: `head` is what the stream has of it so far, from its
 * first byte. Encoders send the decoder's settings in front of the pictures a decoder can start
 * at, so a unit that has both is where a decoder with those settings can go on.
 *
 * Undefined while that can't be told yet: the settings end where the picture begins, which more
 * bytes may still show. `whole` says no more come.
 */
export function videoStart(codec: "h264" | "hevc", head: Uint8Array, whole: boolean): VideoStart | undefined {
  const sets: string[] = [];
  let sps = false;
  let cut = false;
  let marked = false;
  let key: boolean | undefined;
  for (const unit of nalSpans(head)) {
    const kind = nalKind(codec, head, unit.at);
    if (kind.picture) {
      // Its slice header's first bytes say what kind of picture it is.
      if (unit.at + 3 > head.length && !whole) {
        return undefined;
      }
      key = kind.key || (kind.intra && marked);
      break;
    }
    sps ||= kind.type === SPS_NAL[codec];
    const bytes = head.subarray(unit.at, unit.end);
    if (SETTINGS_NALS[codec].has(kind.type)) {
      // One that was still open when the bytes ran out may be cut short: without it they don't count.
      cut = unit.open;
      sets.push(hex(withoutTrailingZeros(bytes)));
    }
    // (HEVC's type 6 is a slice, which ended the search.)
    marked ||= kind.type === H264_SEI_NAL && marksRecovery(bytes.subarray(1));
  }
  if (key === undefined && !whole) {
    return undefined;
  }
  return { settings: sps && !cut ? sets.join(",") : "", key: key ?? false };
}
