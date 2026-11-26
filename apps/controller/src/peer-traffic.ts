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

/** A value of the byte counter: what an engine exchanged with one peer, one way, in one of its places. */
export interface PeerBytes {
  labels: EngineLabels & Record<"peer" | "country" | "direction", string>;
  bytes: number;
}

/** What an engine exchanged with one peer, one way. */
interface Counted {
  /** The gateway's total at the last scrape. */
  seen: number;
  /** What moved while the engine had each of its places, by the place's key. */
  places: Map<string, { role: string; path: string; bytes: number }>;
}

/** An engine whose peers are being counted. */
interface Followed {
  /** The key of the place the engine had at the last scrape: what moved since then counts for it. */
  place: string;
  /** By the direction and the peer's address. */
  peers: Map<string, Counted>;
}

/**
 * Turns the gateway's totals into the byte counter the metrics export, which has the engine's place
 * (`role` and `path`) among its labels. A place changes for the same container, and comes back: a
 * failover makes the playing engine the standby, and the next one makes it the playing engine
 * again. The gateway's total goes on through all of that, so exporting it under the place of the
 * moment would make a series that comes back jump by everything the other series counted meanwhile,
 * and Prometheus would count that twice. A controller restart would do the same to every series.
 *
 * So this counts by itself, from one scrape to the next: what the gateway's total grew by since the
 * previous scrape is added to the place the engine had then. Every series starts at zero, with the
 * scrape that first sees the peer with the engine in that place, and Prometheus counts what follows.
 * A series whose place the engine left stays where it is for as long as the peer is listed, and
 * goes on from there when the engine comes back to that place.
 *
 * It leaves out what the peers that an engine is first seen with moved until then: the first
 * seconds of a new engine, and after a controller restart everything before it.
 */
export class PeerBytesByPlace {
  /** By the engine's address, stream and container. */
  private engines = new Map<string, Followed>();

  /**
   * One scrape: the counter's values for these engines, which have to be all the engines there are,
   * because the ones left out are forgotten. An engine without an answer of the gateway has no
   * values, and keeps what is counted for it: it goes on from there with the next answer.
   */
  collect(engines: readonly EnginePeers[]): PeerBytes[] {
    const followed = new Map<string, Followed>();
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
      const place = JSON.stringify([labels.role, labels.path]);
      const counted = new Map<string, Counted>();
      for (const peer of peers) {
        const totals = [
          ["down", peer.downBytes],
          ["up", peer.upBytes],
        ] as const;
        for (const [direction, total] of totals) {
          const key = `${direction} ${peer.ip}`;
          const entry: Counted = before?.peers.get(key) ?? { seen: total, places: new Map() };
          let current = entry.places.get(place);
          if (current === undefined) {
            current = { role: labels.role, path: labels.path, bytes: 0 };
            entry.places.set(place, current);
          }
          // A total that is lower than before started over (the peer came back after its
          // connections left the gateway's table, or the gateway restarted) and counts whole.
          const grew = total >= entry.seen ? total - entry.seen : total;
          (entry.places.get(before?.place ?? place) ?? current).bytes += grew;
          entry.seen = total;
          counted.set(key, entry);
          for (const { role, path, bytes } of entry.places.values()) {
            values.push({
              labels: { ...labels, role, path, peer: peer.ip, country: peer.country ?? "", direction },
              bytes,
            });
          }
        }
      }
      followed.set(id, { place, peers: counted });
    }
    this.engines = followed;
    return values;
  }
}
