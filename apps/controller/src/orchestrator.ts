import type { PathStatus, Snapshot, StreamView, WireguardProfileView } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import { isPathAllowed, type NetworkPolicy } from "@aceswarm/shared/network-policy";
import type { AcestreamClient } from "./acestream.ts";
import type { NetgwClient, TranscoderClient } from "./clients.ts";
import type { EngineManager } from "./engines.ts";
import { Mutex } from "./json-file.ts";
import type { ControllerMetrics } from "./metrics.ts";
import type { NetworkPolicyStore } from "./network-policy-store.ts";
import type { NewStream, StreamConfig, StreamPatch, StreamStore } from "./stream-store.ts";
import { hlsUrls } from "./hls-urls.ts";
import { StreamSupervisor, type SupervisorSettings } from "./supervisor.ts";
import type { WireguardStore } from "./wireguard-store.ts";

/** A change the network policy does not allow, such as WireGuard only without any profile. */
export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

export interface OrchestratorDeps {
  store: StreamStore;
  wireguard: WireguardStore;
  policy: NetworkPolicyStore;
  engines: EngineManager;
  ace: AcestreamClient;
  transcoder: TranscoderClient;
  netgw: NetgwClient;
  metrics: ControllerMetrics;
  logger: Logger;
  settings: SupervisorSettings;
  pathPollMs?: number;
}

/** Owns one supervisor per enabled stream and applies changes coming from the API. */
export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly logger: Logger;
  private readonly supervisors = new Map<string, StreamSupervisor>();
  private paths: PathStatus[] = [];
  private pathTimer: NodeJS.Timeout | undefined;
  /** Set once every stored stream has a supervisor; until then the list of engine paths is incomplete. */
  private launched = false;
  /** Serializes policy and profile changes, so "WireGuard only needs a profile" always holds. */
  private readonly networkChanges = new Mutex();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: "orchestrator" });
  }

  async start(): Promise<void> {
    await this.deps.store.load();
    await this.deps.wireguard.init();
    const policyError = await this.deps.policy.load();
    if (policyError !== null) {
      this.logger.error(
        { error: policyError },
        "network policy unreadable; WireGuard only stays on until it is saved again",
      );
    }
    await this.refreshPaths();
    this.pathTimer = setInterval(() => {
      void this.refreshPaths();
    }, this.deps.pathPollMs ?? 5000);

    try {
      await this.deps.engines.ensureImage();
      const known = new Set(this.deps.store.list().map((stream) => stream.id));
      const removed = await this.deps.engines.removeOrphans(known);
      if (removed > 0) {
        this.logger.info({ removed }, "removed engines of deleted streams");
      }
    } catch (error) {
      this.logger.error({ err: error }, "docker is not reachable yet; streams will retry");
    }

    for (const stream of this.deps.store.list()) {
      if (stream.enabled) {
        this.launch(stream);
      }
    }
    this.launched = true;
  }

  /** Stops supervision but leaves engines running so a restarted controller can adopt them. */
  async stop(): Promise<void> {
    if (this.pathTimer !== undefined) {
      clearInterval(this.pathTimer);
    }
    await Promise.all(this.supervisors.values().map((supervisor) => supervisor.stop(false)));
    this.supervisors.clear();
  }

  snapshot(): Snapshot {
    return {
      generatedAt: new Date().toISOString(),
      streams: this.deps.store.list().map((stream) => this.view(stream)),
      paths: this.paths,
      pathStrategy: this.deps.settings.pathStrategy,
      wireguardOnly: this.deps.policy.get().wireguardOnly,
    };
  }

  networkPolicy(): NetworkPolicy {
    return this.deps.policy.get();
  }

  /**
   * Turns WireGuard only on or off. Turning it on needs at least one profile. The gateway reloads
   * the policy right away and cuts engines off the direct path; their supervisors then move them.
   */
  async setNetworkPolicy(policy: NetworkPolicy): Promise<NetworkPolicy> {
    return this.networkChanges.run(async () => {
      const current = this.deps.policy.get();
      if (policy.wireguardOnly === current.wireguardOnly) {
        return current;
      }
      const profiles = await this.deps.wireguard.list();
      if (policy.wireguardOnly && profiles.length === 0) {
        throw new NetworkPolicyError("Add a WireGuard profile before turning on WireGuard only.");
      }
      await this.deps.policy.save(policy);
      this.logger.info({ wireguardOnly: policy.wireguardOnly }, "network policy changed");
      await this.reloadGateway();
      return this.deps.policy.get();
    });
  }

  getStream(id: string): StreamView | undefined {
    const stream = this.deps.store.get(id);
    return stream === undefined ? undefined : this.view(stream);
  }

  async addStream(input: NewStream): Promise<StreamView> {
    const stream = await this.deps.store.add(input);
    this.logger.info({ stream: stream.id, aceId: stream.aceId }, "stream added");
    this.launch(stream);
    return this.view(stream);
  }

  async updateStream(id: string, patch: Pick<StreamPatch, "name" | "enabled">): Promise<StreamView | undefined> {
    const updated = await this.deps.store.update(id, patch);
    if (updated === undefined) {
      return undefined;
    }
    const supervisor = this.supervisors.get(id);
    if (updated.enabled && supervisor === undefined) {
      this.launch(updated);
    } else if (updated.enabled || supervisor === undefined) {
      supervisor?.updateConfig(updated);
    } else {
      this.supervisors.delete(id);
      void supervisor.stop(true);
    }
    return this.view(updated);
  }

  async removeStream(id: string): Promise<boolean> {
    const removed = await this.deps.store.remove(id);
    const supervisor = this.supervisors.get(id);
    this.supervisors.delete(id);
    if (supervisor !== undefined) {
      void supervisor.stop(true);
    } else if (removed) {
      void this.deps.engines.removeAllFor(id).catch(() => undefined);
    }
    if (removed) {
      this.logger.info({ stream: id }, "stream removed");
    }
    return removed;
  }

  restartStream(id: string): boolean {
    const supervisor = this.supervisors.get(id);
    supervisor?.requestRestart();
    return supervisor !== undefined;
  }

  async listProfiles(): Promise<WireguardProfileView[]> {
    return this.deps.wireguard.list();
  }

  async saveProfile(name: string, text: string): Promise<WireguardProfileView> {
    return this.networkChanges.run(async () => {
      const profile = await this.deps.wireguard.save(name, text);
      await this.reloadGateway();
      return profile;
    });
  }

  /** Removes a profile. While WireGuard only is on, the last one stays: streams would have no path. */
  async removeProfile(name: string): Promise<boolean> {
    return this.networkChanges.run(async () => {
      if (this.deps.policy.get().wireguardOnly) {
        const profiles = await this.deps.wireguard.list();
        if (profiles.length === 1 && profiles[0]?.name === name) {
          throw new NetworkPolicyError(
            "WireGuard only is on, so the last profile can't be removed. Turn WireGuard only off first.",
          );
        }
      }
      const removed = await this.deps.wireguard.remove(name);
      if (removed) {
        await this.reloadGateway();
      }
      return removed;
    });
  }

  pathLoad(): Map<string, number> {
    const load = new Map<string, number>();
    for (const supervisor of this.supervisors.values()) {
      if (supervisor.path !== null) {
        load.set(supervisor.path, (load.get(supervisor.path) ?? 0) + 1);
      }
    }
    return load;
  }

  private async reloadGateway(): Promise<void> {
    try {
      await this.deps.netgw.reload();
    } catch (error) {
      this.logger.warn({ err: error }, "network gateway reload failed");
    }
    await this.refreshPaths();
  }

  private async refreshPaths(): Promise<void> {
    try {
      this.paths = await this.deps.netgw.paths();
    } catch (error) {
      this.logger.debug({ err: describeError(error) }, "network gateway unreachable");
      this.paths = [];
      return;
    }
    await this.syncAssignments();
  }

  /**
   * Sends the gateway every engine's path. The gateway keeps them only in memory and blocks
   * engines it has no path for, so this restores them after a gateway restart and lets it drop
   * engines that are gone. It waits until every stream finished starting, so a controller restart
   * never sends an incomplete list.
   */
  private async syncAssignments(): Promise<void> {
    const supervisors = this.supervisors.values().toArray();
    if (!this.launched || supervisors.some((supervisor) => !supervisor.settled)) {
      return;
    }
    const known = new Set(this.paths.map((path) => path.id));
    const assignments = supervisors
      .flatMap((supervisor) => supervisor.assignments())
      .filter((assignment) => known.has(assignment.path));
    try {
      const rejected = await this.deps.netgw.sync(assignments);
      if (rejected.length > 0) {
        this.logger.warn({ rejected }, "the network gateway refused some engine paths");
      }
    } catch (error) {
      this.logger.debug({ err: describeError(error) }, "could not sync engine paths");
    }
  }

  private launch(stream: StreamConfig): void {
    const supervisor = new StreamSupervisor(stream, {
      engines: this.deps.engines,
      ace: this.deps.ace,
      transcoder: this.deps.transcoder,
      netgw: this.deps.netgw,
      store: this.deps.store,
      metrics: this.deps.metrics,
      logger: this.deps.logger,
      settings: this.deps.settings,
      paths: () => this.paths,
      pathAllowed: (path) => isPathAllowed(this.deps.policy.get(), path),
      pathLoad: () => this.pathLoad(),
    });
    this.supervisors.set(stream.id, supervisor);
    supervisor.start();
  }

  private view(stream: StreamConfig): StreamView {
    const supervisor = this.supervisors.get(stream.id);
    if (supervisor !== undefined) {
      return supervisor.view();
    }
    return {
      id: stream.id,
      aceId: stream.aceId,
      aceIdKind: stream.aceIdKind,
      name: stream.name,
      enabled: stream.enabled,
      createdAt: stream.createdAt,
      state: "stopped",
      stateSince: stream.createdAt,
      message: null,
      lastFrameAt: null,
      peers: { connected: null, active: null, countries: [] },
      downloadKBps: null,
      uploadKBps: null,
      path: stream.path,
      recoveries: 0,
      hls: hlsUrls(stream.id),
    };
  }
}
