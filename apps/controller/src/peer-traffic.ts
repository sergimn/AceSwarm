import type { PeerTraffic } from "@aceswarm/shared/api-types";
import type { NetgwClient } from "./clients.ts";

/**
 * How often the controller asks the gateway for the engines' traffic with their peers: as often as
 * the gateway samples its connection table by default (PEERS_INTERVAL_SECONDS).
 */
export const PEER_TRAFFIC_POLL_MS = 5000;

/**
 * Keeps what each engine exchanged with each of its peers, as the gateway last counted it, for the
 * metrics. It is not part of the snapshot: the UI gets no peer addresses.
 */
export class PeerTrafficMonitor {
  private readonly netgw: Pick<NetgwClient, "peerTraffic">;
  /** Undefined before the gateway's first answer, and after a sample it did not answer. */
  private byEngine: Map<string, PeerTraffic[]> | undefined;

  constructor(netgw: Pick<NetgwClient, "peerTraffic">) {
    this.netgw = netgw;
  }

  /**
   * The peers of the engine with this address, at the last sample: none for an engine the gateway
   * lists no peers of. Undefined while there is no answer of the gateway to go by, which is not the
   * same: the engine's peers are then as they were, for all the controller knows.
   */
  of(engineIp: string): PeerTraffic[] | undefined {
    return this.byEngine === undefined ? undefined : (this.byEngine.get(engineIp) ?? []);
  }

  async sample(): Promise<void> {
    try {
      const engines = await this.netgw.peerTraffic();
      this.byEngine = new Map(engines.map(({ ip, peers }) => [ip, peers]));
    } catch (error) {
      // Old totals and speeds would pass for the current ones.
      this.byEngine = undefined;
      throw error;
    }
  }
}

/** What tells an engine's series apart: its stream, its container and its place (see `EnginePlace`). */
export type EngineLabels = Record<"stream" | "engine" | "role" | "path", string>;

/** An engine at a scrape: its labels then, and its peers as the gateway last counted them. */
export interface EnginePeers {
  /** The engine's address, which the gateway knows it by. */
  ip: string;
  labels: EngineLabels;
  /** Undefined while the gateway has no answer (see `PeerTrafficMonitor.of`). */
  peers: readonly PeerTraffic[] | undefined;
}

/** A value of the byte counter: what an engine exchanged with one peer, one way, while the two had these labels. */
export interface PeerBytes {
  labels: EngineLabels & Record<"peer" | "country" | "direction", string>;
  bytes: number;
}

/** What moved under one set of the labels that change while a peer is listed. */
interface Counts {
  role: string;
  path: string;
  country: string;
  down: number;
  up: number;
}

/** What an engine exchanged with one peer. */
interface Counted {
  /** The gateway's totals at the last scrape. */
  seenDown: number;
  seenUp: number;
  /** The key of the labels the peer's series had at the last scrape: what moved since then counts for them. */
  last: string;
  /** What moved under each set of labels the peer had with the engine while it was listed, by their key. */
  series: Map<string, Counts>;
}

/**
 * Turns the gateway's totals into the byte counter the metrics export, which has the engine's place
 * (`role` and `path`) among its labels. A place changes for the same container, and comes back: a
 * failover makes the playing engine the standby, and the next one makes it the playing engine
 * again. The gateway's total goes on through all of that, so exporting it under the place of the
 * moment would make a series that comes back jump by everything the other series counted meanwhile,
 * and Prometheus would count that twice. A controller restart would do the same to every series.
 * So would the peer's country, which is a label too: it is unknown until the gateway has its
 * country database, and a newer database can name another.
 *
 * So this counts by itself, from one scrape to the next: what the gateway's totals grew by since
 * the previous scrape is added to the labels the peer's series had then. Every series starts at
 * zero, with the scrape that first sees the peer with the engine in that place and with that
 * country, and Prometheus counts what follows. A series whose labels no longer hold stays where it
 * is for as long as the peer is listed, and goes on from there when they hold again.
 *
 * It leaves out what the peers that an engine is first seen with moved until then: the first
 * seconds of a new engine, and after a controller restart everything before it. An engine that a
 * scrape leaves out is forgotten, so one that is back at the next scrape starts over the same way.
 */
export class PeerBytesByPlace {
  /** Each engine's peers by their address; the engines by their address, stream and container. */
  private engines = new Map<string, Map<string, Counted>>();

  /**
   * One scrape: the counter's values for these engines, which have to be all the engines there are,
   * because the ones left out are forgotten. An engine without an answer of the gateway has no
   * values, and keeps what is counted for it: it goes on from there with the next answer.
   */
  collect(engines: readonly EnginePeers[]): PeerBytes[] {
    const followed = new Map<string, Map<string, Counted>>();
    const values: PeerBytes[] = [];
    for (const { ip, labels, peers } of engines) {
      // A new container that got the address of one that went is another engine: its peers start
      // over, and the gateway's totals of the old one's connections are not its traffic.
      const id = JSON.stringify([ip, labels.stream, labels.engine]);
      const before = this.engines.get(id);
      if (peers === undefined) {
        if (before !== undefined) {
          followed.set(id, before);
        }
        continue;
      }
      const counted = new Map<string, Counted>();
      for (const peer of peers) {
        const country = peer.country ?? "";
        const key = JSON.stringify([labels.role, labels.path, country]);
        const entry: Counted = before?.get(peer.ip) ?? {
          seenDown: peer.downBytes,
          seenUp: peer.upBytes,
          last: key,
          series: new Map(),
        };
        let current = entry.series.get(key);
        if (current === undefined) {
          current = { role: labels.role, path: labels.path, country, down: 0, up: 0 };
          entry.series.set(key, current);
        }
        // A total that is lower than before started over: the peer came back after its connections
        // left the gateway's table, or the gateway restarted, whose table starts empty with its
        // container. Both totals started over then, also the one that is not lower, and both count
        // whole. Totals that started over and are both above the old ones again pass for growth,
        // which counts too little.
        const whole = peer.downBytes < entry.seenDown || peer.upBytes < entry.seenUp;
        const earlier = entry.series.get(entry.last) ?? current;
        earlier.down += whole ? peer.downBytes : peer.downBytes - entry.seenDown;
        earlier.up += whole ? peer.upBytes : peer.upBytes - entry.seenUp;
        entry.seenDown = peer.downBytes;
        entry.seenUp = peer.upBytes;
        entry.last = key;
        counted.set(peer.ip, entry);
        for (const { role, path, country: of, down, up } of entry.series.values()) {
          // In the order of the speeds' labels: a scrape writes them in the order it gets them.
          const series = { ...labels, role, path, peer: peer.ip, country: of };
          values.push(
            { labels: { ...series, direction: "down" }, bytes: down },
            { labels: { ...series, direction: "up" }, bytes: up },
          );
        }
      }
      followed.set(id, counted);
    }
    this.engines = followed;
    return values;
  }
}
