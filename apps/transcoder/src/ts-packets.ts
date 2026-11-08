/** MPEG-TS: packets of 188 bytes, each starting with the sync byte. */
const PACKET_BYTES = 188;
const SYNC_BYTE = 0x47;
/** Padding packets, which a muxer sends to keep the bitrate: they carry nothing. */
const NULL_PID = 0x1f_ff;
/** PIDs below this carry tables (PAT, SDT, EIT and the like), not audio or video. */
const FIRST_STREAM_PID = 0x20;
/** In-sync packets in a row needed to lock on: random bytes all but never line up this long. */
const LOCK_PACKETS = 5;

/**
 * Finds MPEG-TS packets in a byte stream that arrives in chunks of any size. It locks on once
 * `LOCK_PACKETS` sync bytes line up 188 bytes apart, and loses the lock at the first packet that
 * doesn't start with one. Zeros, random bytes or anything else that isn't MPEG-TS never lock.
 */
export class TsPackets {
  private pending: Uint8Array = new Uint8Array(0);
  private locked = false;

  /**
   * Feeds the next chunk, and returns how many of the packets it completed carry stream data: in
   * sync, without the transport error flag, with a payload, on a PID of audio or video (not a
   * table) and not padding. A packet whose end hasn't come yet counts with the chunk that brings it.
   * Which PID holds the video isn't checked (that would mean following the PMT and knowing every
   * codec's stream type); a decode check covers that.
   */
  push(chunk: Uint8Array): number {
    const data = this.pending.length === 0 ? chunk : concat(this.pending, chunk);
    let at = 0;
    let packets = 0;
    for (;;) {
      if (this.locked) {
        if (data.length - at < PACKET_BYTES) {
          break;
        }
        if (data[at] !== SYNC_BYTE) {
          this.locked = false;
          continue;
        }
        if (carriesData(data, at)) {
          packets += 1;
        }
        at += PACKET_BYTES;
      } else {
        if (data.length - at < PACKET_BYTES * LOCK_PACKETS) {
          break;
        }
        if (inSync(data, at)) {
          this.locked = true;
        } else {
          at += 1;
        }
      }
    }
    // At most one partial packet when locked, or the bytes still too few to lock on.
    this.pending = data.slice(at);
    return packets;
  }
}

function inSync(data: Uint8Array, at: number): boolean {
  for (let packet = 0; packet < LOCK_PACKETS; packet += 1) {
    if (data[at + packet * PACKET_BYTES] !== SYNC_BYTE) {
      return false;
    }
  }
  return true;
}

function carriesData(data: Uint8Array, at: number): boolean {
  const flags = data[at + 1] ?? 0;
  const transportError = (flags & 0x80) !== 0;
  const pid = ((flags & 0x1f) << 8) | (data[at + 2] ?? 0);
  const payload = ((data[at + 3] ?? 0) & 0x10) !== 0;
  return !transportError && payload && pid >= FIRST_STREAM_PID && pid !== NULL_PID;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}
