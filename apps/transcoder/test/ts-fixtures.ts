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
