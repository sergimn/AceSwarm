/** Stream data PIDs start above the reserved ones; 0x1fff is padding. */
export const VIDEO_PID = 0x1_00;
export const NULL_PID = 0x1f_ff;

/** `count` MPEG-TS packets on `pid`, with a payload that isn't all zeros. */
export function tsPackets(count: number, pid = VIDEO_PID, flags = 0): Uint8Array {
  const bytes = new Uint8Array(count * 188);
  for (let packet = 0; packet < count; packet += 1) {
    const at = packet * 188;
    bytes.fill(0xa5, at + 4, at + 188);
    bytes[at] = 0x47;
    bytes[at + 1] = flags | ((pid >> 8) & 0x1f);
    bytes[at + 2] = pid & 0xff;
    // Payload only, continuity counter.
    bytes[at + 3] = 0x10 | (packet & 0x0f);
  }
  return bytes;
}

/** Bytes that look like nothing in particular, the same on every run. */
export function noise(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x25_45_f4_91;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** One packet from its first bytes as hex: the rest is stuffing (0xff), as a muxer pads a table's packet. */
export function packetOf(hex: string): Uint8Array {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set(Buffer.from(hex, "hex"));
  return packet;
}

/**
 * The program tables of three streams as ffmpeg's MPEG-TS muxer wrote them: one PAT (program 1,
 * PMT on PID 4095), and the PMT of H.264 video on PID 256 with AAC on 257, of the same on PIDs 211
 * and 221, and of HEVC video on 211 with AAC on 221. All three PMTs carry version 0: a broadcast
 * that switches between such streams changes its layout without changing the version.
 */
export const REAL_TABLES = {
  pat: packetOf("474000100000b00d0001c100000001efff3690e23d"),
  h264: packetOf("474fff100002b0170001c10000e100f0001be100f0000fe101f0002f44b99b"),
  h264Moved: packetOf("474fff100002b0170001c10000e0d3f0001be0d3f0000fe0ddf000b6847c24"),
  hevc: packetOf("474fff100002b01d0001c10000e0d3f00024e0d3f0060504484556430fe0ddf00082367f82"),
};
export const REAL_PMT_PID = 4095;

/** CRC-32/MPEG-2, bit by bit: written apart from the code under test, which uses a table. */
function crcOf(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80_00_00_00) === 0 ? crc << 1 : (crc << 1) ^ 0x04_c1_1d_b7;
    }
  }
  return crc >>> 0;
}

/** A table section: its header, `body` and the CRC. */
export function section(tableId: number, id: number, body: Uint8Array, version = 0, current = true): Uint8Array {
  const length = 5 + body.length + 4;
  const bytes = new Uint8Array(3 + length);
  bytes.set([tableId, 0xb0 | (length >> 8), length & 0xff, id >> 8, id & 0xff]);
  bytes[5] = 0xc0 | ((version & 0x1f) << 1) | (current ? 1 : 0);
  bytes.set(body, 8);
  new DataView(bytes.buffer).setUint32(bytes.length - 4, crcOf(bytes.subarray(0, -4)));
  return bytes;
}

/** A PAT section: each program's number and the PID of its PMT. */
export function patSection(programs: readonly (readonly [number, number])[], version = 0): Uint8Array {
  const body = programs.flatMap(([number, pid]) => [number >> 8, number & 0xff, 0xe0 | (pid >> 8), pid & 0xff]);
  return section(0x00, 1, Uint8Array.from(body), version);
}

export interface TableStream {
  pid: number;
  type: number;
  descriptors?: readonly number[];
}

/** A PMT section of `program` with these streams; the PCR is on the first one's PID. */
export function pmtSection(
  program: number,
  streams: readonly TableStream[],
  options: { version?: number; current?: boolean } = {},
): Uint8Array {
  const pcr = streams[0]?.pid ?? 0x1f_ff;
  const body = [0xe0 | (pcr >> 8), pcr & 0xff, 0xf0, 0];
  for (const { pid, type, descriptors = [] } of streams) {
    const length = descriptors.length;
    body.push(type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0 | (length >> 8), length & 0xff, ...descriptors);
  }
  return section(0x02, program, Uint8Array.from(body), options.version, options.current);
}

/** A section as packets on `pid`, the first one's continuity counter being `counter`. */
export function sectionPackets(pid: number, bytes: Uint8Array, counter = 0): Uint8Array {
  const payload = concatBytes(Uint8Array.of(0), bytes);
  const count = Math.ceil(payload.length / 184);
  const packets = new Uint8Array(count * 188).fill(0xff);
  for (let index = 0; index < count; index += 1) {
    const at = index * 188;
    packets.set([0x47, (index === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x10 | ((counter + index) & 0x0f)], at);
    packets.set(payload.subarray(index * 184, (index + 1) * 184), at + 4);
  }
  return packets;
}

/** A PAT as packets (see `patSection`). */
export function patPackets(programs: readonly (readonly [number, number])[], counter = 0): Uint8Array {
  return sectionPackets(0, patSection(programs), counter);
}

/** The PMT of `program` with these streams, as packets on `pid`. */
export function pmtPackets(streams: readonly TableStream[], counter = 0, pid = 0x10_00, program = 1): Uint8Array {
  return sectionPackets(pid, pmtSection(program, streams), counter);
}

/** The PAT and PMT packets of a stream with one program (number 1), its PMT on `pmtPid`. */
export function tablePackets(streams: readonly TableStream[], pmtPid = 0x10_00, counter = 0): Uint8Array {
  return concatBytes(patPackets([[1, pmtPid]], counter), pmtPackets(streams, counter, pmtPid));
}
