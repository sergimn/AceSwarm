/** H.264 NAL unit types (ITU-T H.264, table 7-1). */
const NAL_SLICE = 1;
const NAL_PARTITION_A = 2;
const NAL_IDR_SLICE = 5;
const NAL_SEI = 6;
/** SEI payload type of a recovery point (ITU-T H.264, D.1.8). */
const SEI_RECOVERY_POINT = 6;
/** ffmpeg takes a recovery point for one only below this many frames (`MAX_LOG2_MAX_FRAME_NUM`). */
const MAX_RECOVERY_FRAMES = 1 << 16;

/**
 * What an access unit of a copied H.264 video is to ffmpeg's HLS muxer (see `cutPointOf`): a
 * picture it can begin a segment at, an IDR one or one after a recovery point, or neither.
 */
export type CutPoint = "idr" | "recovery-point" | "none";

/**
 * Whether ffmpeg can begin a segment of a copied H.264 video at this access unit: whether its H.264
 * parser (`libavcodec/h264_parser.c`, ffmpeg 9) flags the unit's packet as a key frame, which is
 * where the HLS muxer cuts. It does for an IDR slice, and for a slice that a recovery point SEI
 * comes before in the same unit. Its third rule, an I slice of a stream with a single reference
 * frame, is left out, as it needs the stream's parameter sets. So every unit taken for a cut point
 * is one ffmpeg cuts at, and only some it cuts at may be missed.
 *
 * `head` is the start of the access unit as its PES carries it (start codes, then NAL units), up
 * to its first slice. Returns undefined when it ends before that slice: it tells nothing yet.
 */
export function cutPointOf(head: Uint8Array): CutPoint | undefined {
  let recoveryPoint = false;
  for (const nal of nalUnits(head)) {
    const type = (nal[0] ?? 0) & 0x1f;
    if (type === NAL_IDR_SLICE) {
      return "idr";
    }
    if (type === NAL_SLICE || type === NAL_PARTITION_A) {
      return recoveryPoint ? "recovery-point" : "none";
    }
    if (type === NAL_SEI) {
      recoveryPoint ||= hasRecoveryPoint(withoutEmulationPrevention(nal.subarray(1)));
    }
  }
  return undefined;
}

/** The NAL units in `bytes`, each without its start code; the last one may be cut off. */
function* nalUnits(bytes: Uint8Array): Generator<Uint8Array> {
  let start = startCodeEnd(bytes, 0);
  while (start !== undefined && start < bytes.length) {
    const next = startCode(bytes, start);
    // A zero byte before a start code belongs to it (`00 00 00 01`), not to the NAL unit.
    let end = next ?? bytes.length;
    while (next !== undefined && end > start && bytes[end - 1] === 0) {
      end -= 1;
    }
    yield bytes.subarray(start, end);
    start = next === undefined ? undefined : next + 3;
  }
}

/** Where the first start code at or after `from` begins, or undefined. */
function startCode(bytes: Uint8Array, from: number): number | undefined {
  for (let at = from; at + 2 < bytes.length; at += 1) {
    if (bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 1) {
      return at;
    }
  }
  return undefined;
}

function startCodeEnd(bytes: Uint8Array, from: number): number | undefined {
  const at = startCode(bytes, from);
  return at === undefined ? undefined : at + 3;
}

/** The NAL unit's payload with the emulation prevention bytes (`00 00 03`) taken out. */
function withoutEmulationPrevention(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    out[length] = byte;
    length += 1;
  }
  return out.subarray(0, length);
}

/**
 * Whether an SEI unit's messages hold a recovery point ffmpeg accepts: its payload types and sizes
 * are each a run of 0xFF bytes and the byte that ends it (ITU-T H.264, 7.3.2.3.1).
 */
function hasRecoveryPoint(rbsp: Uint8Array): boolean {
  let at = 0;
  // As ffmpeg reads them: a message takes more than two bytes, and none begins with two zeros.
  while (rbsp.length - at > 2 && (rbsp[at] !== 0 || rbsp[at + 1] !== 0)) {
    const type = varSize(rbsp, at);
    const size = varSize(rbsp, type.next);
    if (size.next + size.value > rbsp.length) {
      // ffmpeg stops at a message that runs past the unit; one cut off by `head` tells nothing more.
      return false;
    }
    if (type.value === SEI_RECOVERY_POINT) {
      const frames = expGolomb(rbsp.subarray(size.next, size.next + size.value));
      return frames !== undefined && frames < MAX_RECOVERY_FRAMES;
    }
    at = size.next + size.value;
  }
  return false;
}

function varSize(bytes: Uint8Array, from: number): { value: number; next: number } {
  let value = 0;
  let at = from;
  while (bytes[at] === 0xff) {
    value += 0xff;
    at += 1;
  }
  return { value: value + (bytes[at] ?? 0), next: at + 1 };
}

/** The unsigned Exp-Golomb number the bytes begin with, or undefined when they end first. */
function expGolomb(bytes: Uint8Array): number | undefined {
  const bits = bytes.length * 8;
  const bit = (index: number): number => ((bytes[index >> 3] ?? 0) >> (7 - (index & 7))) & 1;
  let zeros = 0;
  while (zeros < bits && bit(zeros) === 0) {
    zeros += 1;
  }
  if (zeros >= 32 || 2 * zeros + 1 > bits) {
    return undefined;
  }
  let value = 0;
  for (let index = zeros + 1; index <= 2 * zeros; index += 1) {
    value = value * 2 + bit(index);
  }
  return 2 ** zeros - 1 + value;
}
