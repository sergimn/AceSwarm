import { describe, expect, test } from "vitest";
import { TsPackets } from "../src/ts-packets.ts";
import { concatBytes, noise, NULL_PID, tsPackets } from "./ts-fixtures.ts";

/** Feeds `bytes` in chunks of `size` bytes and returns how many packets of stream data it found. */
function count(bytes: Uint8Array, size = bytes.length): number {
  const packets = new TsPackets();
  let found = 0;
  for (let at = 0; at < bytes.length; at += size) {
    found += packets.push(bytes.subarray(at, at + size));
  }
  return found;
}

/** The same packets with an adaptation field (timing, padding) and no payload. */
function withoutPayload(bytes: Uint8Array): Uint8Array {
  const packets = new Uint8Array(bytes);
  for (let at = 0; at < packets.length; at += 188) {
    packets[at + 3] = 0x20 | ((packets[at + 3] ?? 0) & 0x0f);
  }
  return packets;
}

describe("TsPackets", () => {
  test("counts packets of stream data, whatever the chunk sizes", () => {
    const stream = tsPackets(40);
    for (const size of [1, 7, 188, 1000, 65_536]) {
      expect(count(stream, size)).toBe(40);
    }
  });

  test.each([
    ["zeros", new Uint8Array(188 * 200)],
    ["random bytes", noise(188 * 200)],
    ["padding packets only", tsPackets(200, NULL_PID)],
    ["packets flagged with a transport error", tsPackets(200, 0x1_00, 0x80)],
    ["tables only (PAT, SDT)", concatBytes(tsPackets(100, 0x00), tsPackets(100, 0x11))],
    ["packets without a payload", withoutPayload(tsPackets(200))],
  ])("never counts %s", (_name, bytes) => {
    expect(count(bytes)).toBe(0);
    expect(count(bytes, 1000)).toBe(0);
  });

  test("needs five packets in sync before it counts any", () => {
    expect(count(tsPackets(4))).toBe(0);
    expect(count(tsPackets(5))).toBe(5);
  });

  test("finds the packets after bytes that aren't MPEG-TS", () => {
    const afterNoise = concatBytes(noise(1001), tsPackets(30));
    const afterZeros = concatBytes(new Uint8Array(5000), tsPackets(30));
    expect(count(afterNoise, 500)).toBe(30);
    expect(count(afterZeros, 4096)).toBe(30);
  });

  test("loses the lock where the packets stop, and finds it again", () => {
    const stream = concatBytes(tsPackets(10), noise(777), tsPackets(10), new Uint8Array(3000), tsPackets(10));
    expect(count(stream, 300)).toBe(30);
  });

  test("leaves padding, tables and packets without a payload in the stream out of the count", () => {
    const stream = concatBytes(
      tsPackets(10),
      tsPackets(5, NULL_PID),
      tsPackets(3, 0x00),
      withoutPayload(tsPackets(4)),
      tsPackets(10, 0x1_01),
    );
    expect(count(stream)).toBe(20);
  });
});
