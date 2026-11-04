import type { CountryCount, PeerStats } from "@aceswarm/shared/api-types";
import type { CommandRunner } from "./exec.ts";
import type { GeoLookup } from "./geoip.ts";
import { inSubnet, isPrivate } from "@aceswarm/shared/ipv4";

export interface Flow {
  protocol: string;
  /** Engine address (original source, before NAT). */
  source: string;
  /** Remote peer address. */
  remote: string;
  remotePort: number;
  /** Whether the remote side ever answered. */
  replied: boolean;
  /** Bytes received from the remote side; undefined without conntrack accounting. */
  receivedBytes: number | undefined;
  key: string;
}

/** Parses `conntrack -L` output (default format, with or without accounting counters). */
export function parseConntrack(output: string): Flow[] {
  const flows: Flow[] = [];
  for (const line of output.split("\n")) {
    const protocol = /^(?:ipv4\s+\d+\s+)?(tcp|udp)\s/.exec(line)?.[1];
    if (protocol === undefined) {
      continue;
    }
    const sources = line
      .matchAll(/\bsrc=(\S+)/g)
      .map((match) => match[1] ?? "")
      .toArray();
    const destinations = line
      .matchAll(/\bdst=(\S+)/g)
      .map((match) => match[1] ?? "")
      .toArray();
    const sourcePorts = line
      .matchAll(/\bsport=(\d+)/g)
      .map((match) => match[1] ?? "")
      .toArray();
    const destinationPorts = line
      .matchAll(/\bdport=(\d+)/g)
      .map((match) => match[1] ?? "")
      .toArray();
    const bytes = line
      .matchAll(/\bbytes=(\d+)/g)
      .map((match) => Number.parseInt(match[1] ?? "0", 10))
      .toArray();
    const source = sources[0];
    const remote = destinations[0];
    if (source === undefined || remote === undefined) {
      continue;
    }
    const established = protocol === "udp" || /\bESTABLISHED\b/.test(line);
    flows.push({
      protocol,
      source,
      remote,
      remotePort: Number.parseInt(destinationPorts[0] ?? "0", 10),
      replied: established && !line.includes("[UNREPLIED]"),
      receivedBytes: bytes.length >= 2 ? bytes[1] : undefined,
      key: `${protocol}|${source}|${sourcePorts[0] ?? ""}|${remote}|${destinationPorts[0] ?? ""}`,
    });
  }
  return flows;
}

function topCountries(ips: Iterable<string>, geo: GeoLookup, limit: number): CountryCount[] {
  const counts = new Map<string, number>();
  for (const ip of ips) {
    const code = geo.country(ip);
    if (code !== undefined) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([code, count]) => ({ code, count }))
    .toSorted((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, limit);
}

/**
 * Derives peer statistics per engine from the gateway's connection tracking table: the gateway
 * routes every engine, so it sees each engine's peers, which the engine API does not expose.
 * "Active" peers are those whose received byte counter grew since the previous sample.
 */
export class PeerTracker {
  private readonly runner: CommandRunner;
  private readonly geo: GeoLookup;
  private readonly subnet: string;
  private readonly ignoredPorts: ReadonlySet<number>;
  private readonly now: () => number;
  private previousBytes = new Map<string, number>();
  private stats = new Map<string, PeerStats>();

  constructor(
    runner: CommandRunner,
    geo: GeoLookup,
    subnet: string,
    ignoredPorts: number[],
    now: () => number = Date.now,
  ) {
    this.runner = runner;
    this.geo = geo;
    this.subnet = subnet;
    this.ignoredPorts = new Set(ignoredPorts);
    this.now = now;
  }

  get(ip: string): PeerStats {
    return (
      this.stats.get(ip) ?? {
        ip,
        connected: 0,
        active: null,
        countries: [],
        updatedAt: new Date(this.now()).toISOString(),
      }
    );
  }

  all(): PeerStats[] {
    return this.stats.values().toArray();
  }

  async poll(): Promise<void> {
    const result = await this.runner.run("conntrack", ["-L", "-f", "ipv4"], { allowFailure: true });
    this.update(parseConntrack(result.stdout));
  }

  update(flows: Flow[]): void {
    const perEngine = new Map<string, { connected: Set<string>; active: Set<string>; accounted: boolean }>();
    const bytes = new Map<string, number>();
    for (const flow of flows) {
      if (!inSubnet(flow.source, this.subnet) || isPrivate(flow.remote) || this.ignoredPorts.has(flow.remotePort)) {
        continue;
      }
      let entry = perEngine.get(flow.source);
      if (entry === undefined) {
        entry = { connected: new Set(), active: new Set(), accounted: false };
        perEngine.set(flow.source, entry);
      }
      if (flow.replied) {
        entry.connected.add(flow.remote);
      }
      if (flow.receivedBytes === undefined) {
        continue;
      }
      entry.accounted = true;
      bytes.set(flow.key, flow.receivedBytes);
      if (flow.receivedBytes > (this.previousBytes.get(flow.key) ?? 0)) {
        entry.active.add(flow.remote);
      }
    }
    this.previousBytes = bytes;
    const updatedAt = new Date(this.now()).toISOString();
    const stats = new Map<string, PeerStats>();
    for (const [ip, entry] of perEngine) {
      const ranked = entry.accounted && entry.active.size > 0 ? entry.active : entry.connected;
      stats.set(ip, {
        ip,
        connected: entry.connected.size,
        active: entry.accounted ? entry.active.size : null,
        countries: topCountries(ranked, this.geo, 5),
        updatedAt,
      });
    }
    this.stats = stats;
  }
}
