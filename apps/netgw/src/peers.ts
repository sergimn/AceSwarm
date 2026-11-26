import type { CountryCount, EnginePeerTraffic, PeerStats, PeerTraffic } from "@aceswarm/shared/api-types";
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
  /** Bytes the engine sent to the remote side, headers included; undefined without accounting. */
  sentBytes: number | undefined;
  key: string;
}

/**
 * Stream data that must move between two samples (PEERS_INTERVAL_SECONDS) for a peer to count as
 * sending to the engine, or as getting data from it: one 16 KiB block.
 */
export const DATA_MIN_BYTES = 16_384;

/**
 * Share of the traffic one way that the traffic the other way may make up without being stream
 * data. Every transfer sends traffic back: acknowledgements (a packet of about 52 bytes for every
 * one or two received, under 4% of what was received) and requests for the next blocks. On a fast
 * transfer they add up to more than a block between two samples, but they carry no stream data. A
 * peer the engine both downloads from and uploads to counts in a direction only once more than this
 * share is left over, so the counts lean low rather than high.
 */
export const REPLY_SHARE = 1 / 8;

/** The stream data in one direction: what moved that way, less the share of what moved back. */
function streamData(moved: number, back: number): number {
  return moved - Math.max(0, back) * REPLY_SHARE;
}

/** What an engine and one of its peers exchanged: in all, and per second between the last two samples. */
interface PeerCounters {
  down: number;
  up: number;
  downRate: number;
  upRate: number;
}

/**
 * How much a flow's byte counter grew since the previous sample: all of it for a flow seen for the
 * first time, and for one whose counter is lower than before, which is a new connection between the
 * same two ports.
 */
function grown(current: number, previous: number | undefined): number {
  return previous === undefined || current < previous ? current : current - previous;
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
      sentBytes: bytes.length >= 2 ? bytes[0] : undefined,
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
 * "Active" peers are connected ones that sent the engine at least DATA_MIN_BYTES more than
 * REPLY_SHARE of what it sent them since the previous sample, and "uploading" peers those the engine
 * sent at least DATA_MIN_BYTES more than REPLY_SHARE of what they sent it since then. So neither
 * counts the traffic every connection carries: acknowledgements, handshakes, resets and the short
 * answers of trackers and DHT nodes.
 *
 * It also adds up what each engine exchanged with each of its peers (`traffic`): every byte the
 * table counts either way, headers and acknowledgements included, for as long as the peer has a
 * connection in the table.
 */
export class PeerTracker {
  private readonly runner: CommandRunner;
  private readonly geo: GeoLookup;
  private readonly subnet: string;
  private readonly ignoredPorts: ReadonlySet<number>;
  private readonly now: () => number;
  private previousBytes = new Map<string, number>();
  private previousSent = new Map<string, number>();
  private stats = new Map<string, PeerStats>();
  /** Per engine, what it exchanged with each remote address that has a flow in the table. */
  private peerTraffic = new Map<string, Map<string, PeerCounters>>();
  /** When the previous sample was taken; undefined before the first. */
  private sampledAt: number | undefined;

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
        uploading: null,
        countries: [],
        updatedAt: new Date(this.now()).toISOString(),
      }
    );
  }

  all(): PeerStats[] {
    return this.stats.values().toArray();
  }

  /**
   * The traffic of every engine with each peer that answered it, most traffic first. An address
   * that never sent the engine a byte is no peer, however often the engine tried it.
   */
  traffic(): EnginePeerTraffic[] {
    return this.stats
      .values()
      .map(({ ip, updatedAt }) => ({ ip, peers: this.trafficOf(ip), updatedAt }))
      .toArray();
  }

  private trafficOf(engine: string): PeerTraffic[] {
    return [...(this.peerTraffic.get(engine) ?? [])]
      .filter(([, peer]) => peer.down > 0)
      .map(([ip, peer]) => ({
        ip,
        country: this.geo.country(ip) ?? null,
        downBytes: peer.down,
        upBytes: peer.up,
        downBytesPerSecond: Math.round(peer.downRate),
        upBytesPerSecond: Math.round(peer.upRate),
      }))
      .toSorted((a, b) => b.downBytes + b.upBytes - (a.downBytes + a.upBytes) || a.ip.localeCompare(b.ip));
  }

  async poll(): Promise<void> {
    const result = await this.runner.run("conntrack", ["-L", "-f", "ipv4"], { allowFailure: true });
    this.update(parseConntrack(result.stdout));
  }

  update(flows: Flow[]): void {
    const perEngine = new Map<
      string,
      { connected: Set<string>; active: Set<string>; uploading: Set<string>; accounted: boolean }
    >();
    const bytes = new Map<string, number>();
    const sent = new Map<string, number>();
    const now = this.now();
    const seconds = this.sampledAt === undefined ? 0 : (now - this.sampledAt) / 1000;
    const traffic = new Map<string, Map<string, PeerCounters>>();
    for (const flow of flows) {
      if (!inSubnet(flow.source, this.subnet) || isPrivate(flow.remote) || this.ignoredPorts.has(flow.remotePort)) {
        continue;
      }
      let entry = perEngine.get(flow.source);
      if (entry === undefined) {
        entry = { connected: new Set(), active: new Set(), uploading: new Set(), accounted: false };
        perEngine.set(flow.source, entry);
      }
      if (flow.replied) {
        entry.connected.add(flow.remote);
      }
      if (flow.receivedBytes === undefined) {
        continue;
      }
      entry.accounted = true;
      this.addTraffic(traffic, flow, flow.receivedBytes, seconds);
      bytes.set(flow.key, flow.receivedBytes);
      const received = flow.receivedBytes - (this.previousBytes.get(flow.key) ?? 0);
      let sentNow = 0;
      if (flow.sentBytes !== undefined) {
        sent.set(flow.key, flow.sentBytes);
        sentNow = flow.sentBytes - (this.previousSent.get(flow.key) ?? 0);
        if (streamData(sentNow, received) >= DATA_MIN_BYTES) {
          entry.uploading.add(flow.remote);
        }
      }
      if (flow.replied && streamData(received, sentNow) >= DATA_MIN_BYTES) {
        entry.active.add(flow.remote);
      }
    }
    this.previousBytes = bytes;
    this.previousSent = sent;
    this.peerTraffic = traffic;
    this.sampledAt = now;
    const updatedAt = new Date(now).toISOString();
    const stats = new Map<string, PeerStats>();
    for (const [ip, entry] of perEngine) {
      // One set, whatever the sample: the peers sending data, or every connected one when there is
      // no accounting to tell them apart. Switching between them whenever nobody sends would make
      // the countries jump without the swarm changing.
      const ranked = entry.accounted ? entry.active : entry.connected;
      stats.set(ip, {
        ip,
        connected: entry.connected.size,
        active: entry.accounted ? entry.active.size : null,
        uploading: entry.accounted ? entry.uploading.size : null,
        countries: topCountries(ranked, this.geo, 5),
        updatedAt,
      });
    }
    this.stats = stats;
  }

  /**
   * Adds what a flow moved since the previous sample to its peer's traffic with the engine, which
   * goes on from the previous sample's. A flow seen for the first time counts in the totals with
   * everything it moved so far, but not in the speeds: it moved that since it began, not since the
   * previous sample, and after a gateway restart every flow is new.
   */
  private addTraffic(
    traffic: Map<string, Map<string, PeerCounters>>,
    flow: Flow,
    receivedBytes: number,
    seconds: number,
  ): void {
    let peers = traffic.get(flow.source);
    if (peers === undefined) {
      peers = new Map();
      traffic.set(flow.source, peers);
    }
    let peer = peers.get(flow.remote);
    if (peer === undefined) {
      const before = this.peerTraffic.get(flow.source)?.get(flow.remote);
      peer = { down: before?.down ?? 0, up: before?.up ?? 0, downRate: 0, upRate: 0 };
      peers.set(flow.remote, peer);
    }
    const down = grown(receivedBytes, this.previousBytes.get(flow.key));
    const up = grown(flow.sentBytes ?? 0, this.previousSent.get(flow.key));
    peer.down += down;
    peer.up += up;
    if (seconds <= 0 || !this.previousBytes.has(flow.key)) {
      return;
    }
    peer.downRate += down / seconds;
    peer.upRate += up / seconds;
  }
}
