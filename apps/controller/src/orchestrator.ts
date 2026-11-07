import type {
  PathStatus,
  Settings,
  Snapshot,
  StreamView,
  ViewerView,
  WireguardProfileView,
} from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import { isPathAllowed, type NetworkPolicy } from "@aceswarm/shared/network-policy";
import type { AcestreamClient } from "./acestream.ts";
import type { NetgwClient, TranscoderClient } from "./clients.ts";
import type { EngineManager } from "./engines.ts";
import { Mutex } from "./json-file.ts";
import type { ControllerMetrics } from "./metrics.ts";
import type { NetworkPolicyStore } from "./network-policy-store.ts";
import type { SettingsStore } from "./settings-store.ts";
import type { SharedEngines } from "./shared-engines.ts";
import { DEFAULT_STANDBY_SETTINGS, type StandbySettings } from "./standby.ts";
import type { NewStream, StreamConfig, StreamPatch, StreamStore } from "./stream-store.ts";
import { MoveSlots } from "./stream-paths.ts";
import { streamView } from "./stream-view.ts";
import { StreamSupervisor, type SupervisorSettings } from "./supervisor.ts";
import type { Viewers } from "./viewers.ts";
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
  /** Settings changed from the UI, such as engine sharing. */
  settingsStore: SettingsStore;
  /** The engines streams share, one per path, while engine sharing is on. */
  shared: SharedEngines;
  /** Who watches which stream full screen. */
  viewers: Viewers;
  engines: EngineManager;
  ace: AcestreamClient;
  transcoder: TranscoderClient;
  netgw: NetgwClient;
  metrics: ControllerMetrics;
  logger: Logger;
  settings: SupervisorSettings;
  /** How many streams at once may keep the new engine of a failed move (see `StreamEngines.move`). */
  maxKeptEngines?: number;
  /** Hot standbys on the other paths (see `StreamStandbys`). */
  standby?: StandbySettings;
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
  /**
   * Streams moving off the direct path when WireGuard only is turned on, or off a shared engine
   * when sharing is turned off, at most two at a time: each move starts an engine, and N at once
   * would briefly need twice the engines' memory.
   */
  private readonly policyMoves = new MoveSlots(2);
  /** Engines kept after a failed move to try again on them; each is an engine more, so only a few. */
  private readonly spareSlots: MoveSlots;
  /**
   * Standbys starting, at most two at a time across every stream: each starts an engine (or a
   * session on a path's shared engine), and starting them all at once would load the host.
   */
  private readonly standbyStarts = new MoveSlots(2);
  private readonly standby: StandbySettings;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.spareSlots = new MoveSlots(deps.maxKeptEngines ?? 2);
    this.standby = deps.standby ?? DEFAULT_STANDBY_SETTINGS;
    this.logger = deps.logger.child({ component: "orchestrator" });
  }

  async start(): Promise<void> {
    await this.deps.store.load();
    const settingsError = await this.deps.settingsStore.load();
    if (settingsError !== null) {
      this.logger.error({ error: settingsError }, "settings unreadable; using the defaults until they are saved again");
    }
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
      sharedEngines: {
        enabled: this.deps.settingsStore.get().sharedEngines,
        maxFailures: this.deps.shared.settings.maxFailures,
        failureWindowSeconds: Math.round(this.deps.shared.settings.failureWindowMs / 1000),
      },
      hotStandby: {
        enabled: this.deps.settingsStore.get().hotStandby,
        maxPaths: this.standby.maxPaths,
        failoverSeconds: Math.round(this.standby.failoverAfterMs / 1000),
      },
      viewerPingSeconds: Math.round(this.deps.viewers.pingMs / 1000),
    };
  }

  getSettings(): Settings {
    return this.deps.settingsStore.get();
  }

  /**
   * Changes settings. Turning engine sharing on or off takes effect on every stream's next check:
   * each one moves to the kind of engine the setting asks for without losing its picture. Turning
   * hot standby on or off starts or removes every stream's standbys on its next check.
   */
  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const before = this.deps.settingsStore.get();
    const after = await this.deps.settingsStore.update(patch);
    if (after.sharedEngines !== before.sharedEngines) {
      this.logger.info({ sharedEngines: after.sharedEngines }, "engine sharing changed");
    }
    if (after.hotStandby !== before.hotStandby) {
      this.logger.info({ hotStandby: after.hotStandby }, "hot standby changed");
    }
    return after;
  }

  /** A player reported the stream it shows full screen (`null` once it closed). */
  reportViewer(viewer: string, stream: string | null, device: string): boolean {
    if (stream !== null && this.deps.store.get(stream) === undefined) {
      return false;
    }
    this.deps.viewers.report(viewer, stream, device);
    return true;
  }

  viewers(): ViewerView[] {
    return this.deps.viewers.list();
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
      const changed = policy.wireguardOnly !== this.deps.policy.get().wireguardOnly;
      // A file that could not be read is written again even with the same value, so the gateway
      // stops reporting it. Writing "on" always needs a profile.
      const save = changed || this.deps.policy.needsSave;
      if (save && policy.wireguardOnly) {
        const profiles = await this.deps.wireguard.list();
        if (profiles.length === 0) {
          throw new NetworkPolicyError("Add a WireGuard profile before turning on WireGuard only.");
        }
      }
      if (save) {
        await this.deps.policy.save(policy);
        this.logger.info({ wireguardOnly: policy.wireguardOnly }, "network policy saved");
      }
      // Also when nothing changed: saving the same value again retries a reload that failed.
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
    this.deps.viewers.forgetStream(id);
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
    await this.sweepSharedEngines();
  }

  /**
   * Removes shared engines nobody uses: the paths' engines that nobody used for a while, and,
   * once every stream had the chance to take its engine, the ones left from a previous run. A
   * stream still waiting for a path it may use (the gateway restarting, WireGuard only with no
   * tunnel up yet) would take over the engine of its previous run.
   */
  private async sweepSharedEngines(): Promise<void> {
    if (!this.launched) {
      return;
    }
    try {
      await this.deps.shared.sweepIdle(this.deps.settingsStore.get().sharedEngines);
      const tried = this.supervisors.values().every((supervisor) => supervisor.triedEngine);
      if (this.allSettled() && tried) {
        await this.deps.shared.sweepOrphans();
      }
    } catch (error) {
      this.logger.debug({ err: describeError(error) }, "could not look for unused shared engines");
    }
  }

  private allSettled(): boolean {
    return this.launched && this.supervisors.values().every((supervisor) => supervisor.settled);
  }

  /**
   * Sends the gateway every engine's path. The gateway keeps them only in memory and blocks
   * engines it has no path for, so this restores them after a gateway restart and lets it drop
   * engines that are gone. It waits until every stream finished starting, so a controller restart
   * never sends an incomplete list.
   */
  private async syncAssignments(): Promise<void> {
    if (!this.allSettled()) {
      return;
    }
    const supervisors = this.supervisors.values().toArray();
    const known = new Set(this.paths.map((path) => path.id));
    const policy = this.deps.policy.get();
    // Engines still waiting to leave a path the policy turned off are not sent: the gateway would
    // only refuse them.
    const assignments = [
      ...supervisors.flatMap((supervisor) => supervisor.assignments()),
      ...this.deps.shared.assignments(),
    ].filter((assignment) => known.has(assignment.path) && isPathAllowed(policy, assignment.path));
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
      policyMoves: this.policyMoves,
      spareSlots: this.spareSlots,
      standby: this.standby,
      standbyStarts: this.standbyStarts,
      pathLoad: () => this.pathLoad(),
      shared: this.deps.shared,
      sharedEngines: () => this.deps.settingsStore.get().sharedEngines,
      hotStandby: () => this.deps.settingsStore.get().hotStandby,
      viewers: () => this.deps.viewers.count(stream.id),
    });
    this.supervisors.set(stream.id, supervisor);
    supervisor.start();
  }

  private view(stream: StreamConfig): StreamView {
    return this.supervisors.get(stream.id)?.view() ?? streamView(stream, this.deps.viewers.count(stream.id));
  }
}
