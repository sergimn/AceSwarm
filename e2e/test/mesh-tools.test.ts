import { describe, expect, it } from "vitest";
import { parseBindingResponse } from "../stun.ts";
import { bencode, compactPeers, inputCommand, parseAnnounce, percentDecodeBytes, Swarm } from "../tracker.ts";

const MAGIC_COOKIE = 0x21_12_a4_42;

function bindingSuccess(transactionId: Buffer, attributeType: number, ip: string, port: number): Buffer {
  const address = ip.split(".").reduce((value, part) => value * 256 + Number.parseInt(part, 10), 0);
  const attribute = Buffer.alloc(12);
  attribute.writeUInt16BE(attributeType, 0);
  attribute.writeUInt16BE(8, 2);
  attribute.writeUInt8(0, 4);
  attribute.writeUInt8(0x01, 5);
  const xor = attributeType === 0x00_20;
  attribute.writeUInt16BE(xor ? port ^ (MAGIC_COOKIE >>> 16) : port, 6);
  attribute.writeUInt32BE(xor ? (address ^ MAGIC_COOKIE) >>> 0 : address, 8);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x01_01, 0);
  header.writeUInt16BE(attribute.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, attribute]);
}

describe("STUN binding responses", () => {
  const transactionId = Buffer.from("0123456789ab");

  it("decodes XOR-MAPPED-ADDRESS", () => {
    const message = bindingSuccess(transactionId, 0x00_20, "172.212.205.188", 33_906);
    expect(parseBindingResponse(message, transactionId)).toEqual({ ip: "172.212.205.188", port: 33_906 });
  });

  it("falls back to MAPPED-ADDRESS", () => {
    const message = bindingSuccess(transactionId, 0x00_01, "9.234.22.211", 17_456);
    expect(parseBindingResponse(message, transactionId)).toEqual({ ip: "9.234.22.211", port: 17_456 });
  });

  it("ignores answers to other requests", () => {
    const message = bindingSuccess(transactionId, 0x00_20, "9.234.22.211", 17_456);
    expect(parseBindingResponse(message, Buffer.from("ba9876543210"))).toBeUndefined();
    expect(parseBindingResponse(Buffer.alloc(8), transactionId)).toBeUndefined();
  });
});

describe("tracker", () => {
  it("stops and starts a broadcast's input container, and nothing else", () => {
    expect(inputCommand("POST", "/inputs/bc4/stop")).toEqual(["stop", "aceswarm-broadcast-input-4"]);
    expect(inputCommand("POST", "/inputs/bc12/start")).toEqual(["start", "aceswarm-broadcast-input-12"]);
    expect(inputCommand("GET", "/inputs/bc4/stop")).toBeUndefined();
    expect(inputCommand("POST", "/inputs/bc4/rm")).toBeUndefined();
    expect(inputCommand("POST", "/inputs/bc4;rm/stop")).toBeUndefined();
    expect(inputCommand("POST", "/inputs/x/stop")).toBeUndefined();
  });

  const infoHash = Buffer.from("7ff57ff270e8fa6851c61af6765009a93de110ae", "hex");
  const escaped = [...infoHash].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");

  it("bencodes dictionaries with sorted keys", () => {
    expect(bencode({ peers: Buffer.from([1, 2]), interval: 15, "min interval": 5 }).toString("latin1")).toBe(
      "d8:intervali15e12:min intervali5e5:peers2:\u{1}\u{2}e",
    );
    expect(bencode(["a", 1]).toString()).toBe("l1:ai1ee");
  });

  it("decodes raw bytes from the query string", () => {
    expect(percentDecodeBytes(escaped)).toEqual(infoHash);
    // Unreserved characters stand for themselves, as Acestream sends them.
    expect(percentDecodeBytes("-%C9b")).toEqual(Buffer.from([0x2d, 0xc9, 0x62]));
  });

  it("parses announces and rejects bad ones", () => {
    expect(parseAnnounce(`info_hash=${escaped}&peer_id=x&port=8621&compact=1&event=started`)).toEqual({
      infoHash: infoHash.toString("hex"),
      port: 8621,
      event: "started",
      compact: true,
    });
    expect(parseAnnounce(`info_hash=${escaped}&port=0`)).toBeUndefined();
    expect(parseAnnounce("info_hash=short&port=8621")).toBeUndefined();
  });

  it("returns the other live peers and remembers every announce", () => {
    const swarm = new Swarm();
    const announce = { infoHash: "ab", port: 7764, event: undefined, compact: true };
    expect(swarm.announce(announce, "192.0.2.2", 1000)).toEqual([]);
    expect(swarm.announce({ ...announce, port: 8621 }, "192.0.2.3", 2000)).toEqual([
      { ip: "192.0.2.2", port: 7764, seen: 1000 },
    ]);
    // A peer that stopped announcing two minutes ago is gone.
    expect(swarm.announce({ ...announce, port: 8621 }, "192.0.2.1", 200_000)).toEqual([]);
    expect(swarm.stats()["ab"]?.map(({ ip }) => ip)).toEqual(["192.0.2.2", "192.0.2.3", "192.0.2.1"]);
  });

  it("packs peers as 6 bytes each", () => {
    expect(compactPeers([{ ip: "192.0.2.2", port: 7764, seen: 0 }])).toEqual(Buffer.from([192, 0, 2, 2, 0x1e, 0x54]));
  });
});
