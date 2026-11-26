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
  private byEngine = new Map<string, PeerTraffic[]>();

  constructor(netgw: Pick<NetgwClient, "peerTraffic">) {
    this.netgw = netgw;
  }

  /** The peers of the engine with this address, at the last sample; none while the gateway did not answer it. */
  of(engineIp: string): PeerTraffic[] {
    return this.byEngine.get(engineIp) ?? [];
  }

  async sample(): Promise<void> {
    try {
      const engines = await this.netgw.peerTraffic();
      this.byEngine = new Map(engines.map(({ ip, peers }) => [ip, peers]));
    } catch (error) {
      // Old totals and speeds would pass for the current ones.
      this.byEngine = new Map();
      throw error;
    }
  }
}
