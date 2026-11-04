import type { PathStatus, Snapshot, StreamView, WireguardProfileView } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import type { AcestreamClient } from "./acestream.ts";
import type { NetgwClient, TranscoderClient } from "./clients.ts";
import type { EngineManager } from "./engines.ts";
import type { ControllerMetrics } from "./metrics.ts";
import type { NewStream, StreamConfig, StreamPatch, StreamStore } from "./stream-store.ts";
import { hlsUrls, StreamSupervisor, type SupervisorSettings } from "./supervisor.ts";
import type { WireguardStore } from "./wireguard-store.ts";

export interface OrchestratorDeps {
  store: StreamStore;
  wireguard: WireguardStore;
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

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: "orchestrator" });
  }

  async start(): Promise<void> {
    await this.deps.store.load();
    await this.deps.wireguard.init();
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
    };
  }

  getStream(id: string): StreamView | undefined {
    const stream = this.deps.store.get(id);
    return stream === undefined ? undefined : this.view(stream);
  }

  async addStream(input: NewStream): Promise<StreamView> {
    const stream = await this.deps.store.add(input);
    this.logger.info({ stream: stream.id, contentId: stream.contentId }, "stream added");
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
    const profile = await this.deps.wireguard.save(name, text);
    await this.reloadGateway();
    return profile;
  }

  async removeProfile(name: string): Promise<boolean> {
    const removed = await this.deps.wireguard.remove(name);
    if (removed) {
      await this.reloadGateway();
    }
    return removed;
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
      contentId: stream.contentId,
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
