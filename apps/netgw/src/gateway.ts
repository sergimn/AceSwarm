import type { PathStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { Firewall, Interfaces } from "./network.ts";
import type { PeerTracker } from "./peers.ts";
import type { Prober, ProbeTarget } from "./probe.ts";
import { DIRECT_PATH, type Router } from "./router.ts";
import type { TunnelManager } from "./tunnels.ts";

/** Ties tunnels, routing, firewall, probes and peer tracking together. */
export class Gateway {
  readonly tunnels: TunnelManager;
  readonly router: Router;
  readonly peers: PeerTracker;
  private readonly firewall: Firewall;
  private readonly prober: Prober;
  private readonly interfaces: Interfaces;
  private readonly logger: Logger;
  private statuses = new Map<string, PathStatus>();
  private reloading: Promise<void> = Promise.resolve();

  constructor(parts: {
    tunnels: TunnelManager;
    router: Router;
    peers: PeerTracker;
    firewall: Firewall;
    prober: Prober;
    interfaces: Interfaces;
    logger: Logger;
  }) {
    this.tunnels = parts.tunnels;
    this.router = parts.router;
    this.peers = parts.peers;
    this.firewall = parts.firewall;
    this.prober = parts.prober;
    this.interfaces = parts.interfaces;
    this.logger = parts.logger;
  }

  async init(): Promise<void> {
    await this.firewall.init(this.interfaces.engines);
    await this.tunnels.cleanup();
    await this.reload();
  }

  /** Re-reads the profiles; concurrent calls are serialized. */
  async reload(): Promise<void> {
    this.reloading = this.reloading
      .catch(() => undefined)
      .then(async () => {
        await this.tunnels.reconcile();
        await this.firewall.setOutputs([
          this.interfaces.egress,
          ...this.tunnels
            .list()
            .filter((tunnel) => tunnel.error === null)
            .map((tunnel) => tunnel.iface),
        ]);
        await this.router.reapply();
        const known = new Set(this.targets().map((target) => target.id));
        for (const id of this.statuses.keys()) {
          if (!known.has(id)) {
            this.statuses.delete(id);
          }
        }
      });
    await this.reloading;
    await this.probeAll();
  }

  /** The direct path first, then one path per tunnel. */
  targets(): ProbeTarget[] {
    return [
      { id: DIRECT_PATH, kind: "direct", label: "Direct", sourceAddress: undefined, iface: undefined, error: null },
      ...this.tunnels.list().map((tunnel): ProbeTarget => ({
        id: tunnel.pathId,
        kind: "wireguard",
        label: tunnel.profile,
        sourceAddress: tunnel.address,
        iface: tunnel.error === null ? tunnel.iface : undefined,
        error: tunnel.error,
      })),
    ];
  }

  paths(): PathStatus[] {
    return this.targets().map(
      (target) =>
        this.statuses.get(target.id) ?? {
          id: target.id,
          kind: target.kind,
          label: target.label,
          up: false,
          rttMs: null,
          loss: null,
          handshakeAgeSeconds: null,
          score: 0,
          lastProbeAt: null,
          error: target.error ?? "not probed yet",
        },
    );
  }

  async probeAll(): Promise<void> {
    const results = await Promise.all(this.targets().map((target) => this.prober.probe(target)));
    for (const result of results) {
      const previous = this.statuses.get(result.id);
      if (previous !== undefined && previous.up !== result.up) {
        this.logger.info({ path: result.id, up: result.up, error: result.error }, "path status changed");
      }
      this.statuses.set(result.id, result);
    }
  }
}
