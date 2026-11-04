import type { PathKind, PathStatus } from "@aceswarm/shared/api-types";
import type { CommandRunner } from "./exec.ts";

export interface PingResult {
  loss: number;
  rttMs: number | null;
}

/** Parses the summary of `ping -q`. */
export function parsePing(output: string): PingResult {
  const counts = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(output);
  const rtt = /= [\d.]+\/([\d.]+)\/[\d.]+/.exec(output);
  const transmitted = Number.parseInt(counts?.[1] ?? "0", 10);
  const received = Number.parseInt(counts?.[2] ?? "0", 10);
  const loss = transmitted === 0 ? 1 : 1 - received / transmitted;
  return { loss, rttMs: rtt?.[1] === undefined ? null : Number.parseFloat(rtt[1]) };
}

/** Newest handshake (unix seconds) from `wg show <iface> latest-handshakes`; 0 means never. */
export function parseLatestHandshake(output: string): number {
  let newest = 0;
  for (const line of output.split("\n")) {
    const value = Number.parseInt(line.trim().split(/\s+/, 2)[1] ?? "0", 10);
    if (Number.isFinite(value) && value > newest) {
      newest = value;
    }
  }
  return newest;
}

/**
 * Health score in [0, 1]: packet loss scales it down linearly and latency gently (20 ms ≈ 0.96,
 * 150 ms ≈ 0.65, 400 ms ≈ 0.49).
 */
export function scorePath(result: PingResult): number {
  if (result.rttMs === null || result.loss >= 1) {
    return 0;
  }
  const latency = 1 / (1 + result.rttMs / 150);
  return Math.round((1 - result.loss) * (0.3 + 0.7 * latency) * 1000) / 1000;
}

export interface ProbeTarget {
  id: string;
  kind: PathKind;
  label: string;
  /** Source address for the probe; undefined uses the default route (direct path). */
  sourceAddress: string | undefined;
  /** WireGuard interface, used to read the handshake age. */
  iface: string | undefined;
  /** Configuration problem that keeps the path down regardless of probes. */
  error: string | null;
}

export class Prober {
  private readonly runner: CommandRunner;
  private readonly targets: string[];
  private readonly handshakeMaxAgeSeconds: number;
  private readonly now: () => number;

  constructor(runner: CommandRunner, targets: string[], handshakeMaxAgeSeconds: number, now: () => number = Date.now) {
    this.runner = runner;
    this.targets = targets;
    this.handshakeMaxAgeSeconds = handshakeMaxAgeSeconds;
    this.now = now;
  }

  async probe(path: ProbeTarget): Promise<PathStatus> {
    const base = {
      id: path.id,
      kind: path.kind,
      label: path.label,
      lastProbeAt: new Date(this.now()).toISOString(),
    };
    if (path.error !== null) {
      return { ...base, up: false, rttMs: null, loss: null, handshakeAgeSeconds: null, score: 0, error: path.error };
    }
    let handshakeAgeSeconds: number | null = null;
    if (path.iface !== undefined) {
      const output = await this.runner.run("wg", ["show", path.iface, "latest-handshakes"], { allowFailure: true });
      const latest = parseLatestHandshake(output.stdout);
      handshakeAgeSeconds = latest === 0 ? null : Math.max(0, Math.round(this.now() / 1000 - latest));
    }
    const ping = await this.ping(path.sourceAddress);
    const handshakeOk =
      path.iface === undefined || (handshakeAgeSeconds !== null && handshakeAgeSeconds <= this.handshakeMaxAgeSeconds);
    const up = ping.loss < 1 && handshakeOk;
    let error: string | null = null;
    if (!handshakeOk) {
      error = "no recent WireGuard handshake";
    } else if (ping.loss >= 1) {
      error = "probe targets unreachable";
    }
    return {
      ...base,
      up,
      rttMs: ping.rttMs,
      loss: ping.loss,
      handshakeAgeSeconds,
      score: up ? scorePath(ping) : 0,
      error,
    };
  }

  /** Pings the targets in order and returns the first that answers at all. */
  private async ping(sourceAddress: string | undefined): Promise<PingResult> {
    let last: PingResult = { loss: 1, rttMs: null };
    for (const target of this.targets) {
      const args = ["-n", "-q", "-c", "3", "-i", "0.3", "-W", "2"];
      if (sourceAddress !== undefined) {
        args.push("-I", sourceAddress);
      }
      args.push(target);
      const result = await this.runner.run("ping", args, { allowFailure: true, timeoutMs: 10_000 });
      last = parsePing(result.stdout);
      if (last.loss < 1) {
        return last;
      }
    }
    return last;
  }
}
