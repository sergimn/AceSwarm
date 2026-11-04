import { describe, expect, it } from "vitest";
import { parseLatestHandshake, parsePing, scorePath } from "../src/probe.ts";

describe("parsePing", () => {
  it("reads iputils output", () => {
    const output = `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.

--- 1.1.1.1 ping statistics ---
5 packets transmitted, 4 received, 20% packet loss, time 4005ms
rtt min/avg/max/mdev = 10.1/12.5/15.0/1.9 ms`;
    const result = parsePing(output);
    expect(result.loss).toBeCloseTo(0.2);
    expect(result.rttMs).toBe(12.5);
  });

  it("reads busybox output", () => {
    const output = `--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 packets received, 0% packet loss
round-trip min/avg/max = 9.8/10.0/10.3 ms`;
    expect(parsePing(output)).toEqual({ loss: 0, rttMs: 10 });
  });

  it("treats no output or no replies as total loss", () => {
    expect(parsePing("")).toEqual({ loss: 1, rttMs: null });
    expect(parsePing("3 packets transmitted, 0 received, 100% packet loss")).toEqual({ loss: 1, rttMs: null });
  });
});

describe("parseLatestHandshake", () => {
  it("returns the newest handshake of any peer", () => {
    expect(parseLatestHandshake("peerA=\t1762257600\npeerB=\t1762257700\n")).toBe(1_762_257_700);
    expect(parseLatestHandshake("peerA=\t0\n")).toBe(0);
    expect(parseLatestHandshake("")).toBe(0);
  });
});

describe("scorePath", () => {
  it("scores loss linearly and latency gently", () => {
    expect(scorePath({ loss: 0, rttMs: 0 })).toBe(1);
    expect(scorePath({ loss: 0, rttMs: 20 })).toBeCloseTo(0.918, 3);
    expect(scorePath({ loss: 0.5, rttMs: 20 })).toBeCloseTo(0.459, 3);
    expect(scorePath({ loss: 1, rttMs: 20 })).toBe(0);
    expect(scorePath({ loss: 0, rttMs: null })).toBe(0);
  });
});
