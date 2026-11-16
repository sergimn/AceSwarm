import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../src/exec.ts";
import { parseLatestHandshake, parsePing, Prober, scorePath, type ProbeTarget } from "../src/probe.ts";

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

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const PING_OK = `3 packets transmitted, 3 received, 0% packet loss, time 601ms
rtt min/avg/max/mdev = 0.5/0.6/0.7/0.1 ms`;
const PING_LOST = "3 packets transmitted, 0 received, 100% packet loss, time 2003ms";

/** Answers `wg show` with a fresh handshake and each ping from a table keyed by its `-I` argument. */
class FakeRunner implements CommandRunner {
  readonly pings: string[][] = [];
  private readonly replies: Map<string | undefined, string>;

  /** `replies` by interface; a ping without `-I` (the direct path) is always answered. */
  constructor(replies: Record<string, string>) {
    this.replies = new Map<string | undefined, string>([...Object.entries(replies), [undefined, PING_OK]]);
  }

  run(command: string, args: string[]): Promise<CommandResult> {
    if (command === "wg") {
      return Promise.resolve({ stdout: `PEER\t${String(NOW / 1000 - 10)}\n`, stderr: "", code: 0 });
    }
    this.pings.push([command, ...args]);
    const bound = args[args.indexOf("-I") + 1];
    const stdout = this.replies.get(args.includes("-I") ? bound : undefined) ?? PING_LOST;
    return Promise.resolve({ stdout, stderr: "", code: stdout === PING_OK ? 0 : 1 });
  }
}

function tunnelTarget(label: string, iface: string): ProbeTarget {
  return { id: `wg:${label}`, kind: "wireguard", label, iface, error: null };
}

describe("Prober", () => {
  it("probes each tunnel through its own interface, so tunnels with the same Address get their own result", async () => {
    // The two tunnels share an Address; only the second one reaches the probe target.
    const runner = new FakeRunner({ aswg0: PING_LOST, aswg1: PING_OK });
    const prober = new Prober(runner, ["1.1.1.1"], 180, () => NOW);
    const [first, second] = await Promise.all([
      prober.probe(tunnelTarget("proton-ch", "aswg0")),
      prober.probe(tunnelTarget("proton-nl", "aswg1")),
    ]);
    expect(first).toMatchObject({ id: "wg:proton-ch", up: false, loss: 1, error: "probe targets unreachable" });
    expect(second).toMatchObject({ id: "wg:proton-nl", up: true, loss: 0, rttMs: 0.6, error: null });
    expect(runner.pings.map((args) => args.slice(-3))).toEqual([
      ["-I", "aswg0", "1.1.1.1"],
      ["-I", "aswg1", "1.1.1.1"],
    ]);
  });

  it("probes the direct path on the default route", async () => {
    const runner = new FakeRunner({});
    const prober = new Prober(runner, ["1.1.1.1"], 180, () => NOW);
    const status = await prober.probe({ id: "direct", kind: "direct", label: "Direct", iface: undefined, error: null });
    expect(status.up).toBe(true);
    expect(runner.pings).toHaveLength(1);
    expect(runner.pings[0]).not.toContain("-I");
  });

  it("does not probe a tunnel that could not be set up, and never falls back to the default route", async () => {
    const runner = new FakeRunner({});
    const prober = new Prober(runner, ["1.1.1.1"], 180, () => NOW);
    const status = await prober.probe({ ...tunnelTarget("broken", "aswg0"), iface: undefined, error: "bad profile" });
    expect(status).toMatchObject({ up: false, score: 0, error: "bad profile" });
    expect(runner.pings).toEqual([]);
  });
});
