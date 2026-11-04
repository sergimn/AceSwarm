import type { PathAssignment } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { CommandRunner } from "./exec.ts";
import { inSubnet } from "./ipv4.ts";
import type { Tunnel } from "./tunnels.ts";

export const DIRECT_PATH = "direct";
const ENGINE_RULE_PRIORITY = 1000;

export class UnknownPathError extends Error {
  constructor(path: string) {
    super(`unknown path ${path}`);
    this.name = "UnknownPathError";
  }
}

/** Forwarding permissions per engine (see Firewall): an engine may only leave through its path. */
export interface PathFirewall {
  allow(ip: string, iface: string): Promise<void>;
  revoke(ip: string, iface: string): Promise<void>;
}

export interface RouterOptions {
  runner: CommandRunner;
  /** The engines network. */
  subnet: string;
  /** Interface of the direct path. */
  directIface: string;
  tunnel: (pathId: string) => Tunnel | undefined;
  firewall: PathFirewall;
  logger: Logger;
  now?: () => number;
}

export interface RejectedAssignment extends PathAssignment {
  error: string;
}

interface Assignment {
  path: string;
  iface: string;
  /** Last time the controller asked for this assignment. */
  confirmedAt: number;
}

/**
 * Per-engine paths. Tunnels get a policy rule (`ip rule add from <engine> lookup <table>`) and
 * the direct path uses the main table. The firewall only forwards an engine's traffic out of the
 * interface of its own path, so an engine without an assignment (for example right after the
 * gateway restarted) or with a broken tunnel is cut off instead of leaking out the direct path.
 * Changing the path flushes the engine's tracked connections so they are re-established (and
 * re-NATed) through the new path.
 */
export class Router {
  private readonly runner: CommandRunner;
  private readonly subnet: string;
  private readonly directIface: string;
  private readonly tunnel: (pathId: string) => Tunnel | undefined;
  private readonly firewall: PathFirewall;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly assignments = new Map<string, Assignment>();

  constructor(options: RouterOptions) {
    this.runner = options.runner;
    this.subnet = options.subnet;
    this.directIface = options.directIface;
    this.tunnel = options.tunnel;
    this.firewall = options.firewall;
    this.logger = options.logger.child({ component: "router" });
    this.now = options.now ?? Date.now;
  }

  list(): PathAssignment[] {
    return [...this.assignments].map(([ip, assignment]) => ({ ip, path: assignment.path }));
  }

  /** The engine's path, or undefined when it has none (and cannot reach the internet). */
  pathOf(ip: string): string | undefined {
    return this.assignments.get(ip)?.path;
  }

  isEngineIp(ip: string): boolean {
    return inSubnet(ip, this.subnet);
  }

  /** Gives an engine a path. Asking again for the same path only confirms it, unless forced. */
  async assign(ip: string, path: string, force = false): Promise<void> {
    if (!this.isEngineIp(ip)) {
      throw new Error(`${ip} is not on the engines network ${this.subnet}`);
    }
    const tunnel = this.usableTunnel(path);
    const iface = tunnel?.iface ?? this.directIface;
    const previous = this.assignments.get(ip);
    if (!force && previous?.path === path && previous.iface === iface) {
      previous.confirmedAt = this.now();
      return;
    }

    await this.clearRules(ip);
    if (previous !== undefined) {
      await this.firewall.revoke(ip, previous.iface);
    }
    if (tunnel !== undefined) {
      await this.runner.run("ip", [
        "-4",
        "rule",
        "add",
        "from",
        `${ip}/32`,
        "lookup",
        String(tunnel.table),
        "priority",
        String(ENGINE_RULE_PRIORITY),
      ]);
    }
    await this.firewall.allow(ip, iface);
    this.assignments.set(ip, { path, iface, confirmedAt: this.now() });
    if (previous !== undefined && previous.path !== path) {
      await this.flushConnections(ip);
    }
    if (previous?.path !== path) {
      this.logger.info({ ip, from: previous?.path ?? null, to: path }, "engine path assigned");
    }
  }

  async unassign(ip: string): Promise<void> {
    const previous = this.assignments.get(ip);
    if (previous === undefined) {
      return;
    }
    await this.clearRules(ip);
    await this.firewall.revoke(ip, previous.iface);
    this.assignments.delete(ip);
    await this.flushConnections(ip);
  }

  /**
   * Re-applies every assignment after the tunnels changed. Engines whose tunnel is gone lose
   * their path (and connectivity) until the controller moves them, rather than going direct.
   */
  async reapply(): Promise<void> {
    // Iterate over a copy: assign() writes to the map, and a Map iterator also visits keys that
    // are re-inserted while it runs, which would never end.
    const current = [...this.assignments];
    for (const [ip, assignment] of current) {
      try {
        await this.assign(ip, assignment.path, true);
      } catch (error) {
        if (!(error instanceof UnknownPathError)) {
          throw error;
        }
        this.logger.warn({ ip, path: assignment.path }, "path removed; engine blocked until it gets a new one");
        await this.unassign(ip);
      }
    }
  }

  /**
   * Makes the assignments match what the controller wants: missing or different ones are applied,
   * and engines the controller no longer mentions are cut off once they have gone unconfirmed for
   * `graceMs` (which covers a single assignment racing with this call).
   */
  async sync(desired: readonly PathAssignment[], graceMs: number): Promise<RejectedAssignment[]> {
    const rejected: RejectedAssignment[] = [];
    const wanted = new Set<string>();
    for (const { ip, path } of desired) {
      wanted.add(ip);
      try {
        await this.assign(ip, path);
      } catch (error) {
        rejected.push({ ip, path, error: (error as Error).message });
      }
    }
    const cutoff = this.now() - graceMs;
    // A copy again, because unassign() deletes from the map.
    const current = [...this.assignments];
    for (const [ip, assignment] of current) {
      if (!wanted.has(ip) && assignment.confirmedAt < cutoff) {
        this.logger.info({ ip, path: assignment.path }, "removing stale engine assignment");
        await this.unassign(ip);
      }
    }
    return rejected;
  }

  /** The tunnel behind a path (undefined for the direct path); throws for unusable paths. */
  private usableTunnel(path: string): Tunnel | undefined {
    if (path === DIRECT_PATH) {
      return undefined;
    }
    const tunnel = this.tunnel(path);
    if (tunnel?.error !== null) {
      throw new UnknownPathError(path);
    }
    return tunnel;
  }

  private async clearRules(ip: string): Promise<void> {
    // Delete until none is left, in case an earlier run left duplicates behind.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await this.runner.run(
        "ip",
        ["-4", "rule", "del", "from", `${ip}/32`, "priority", String(ENGINE_RULE_PRIORITY)],
        { allowFailure: true },
      );
      if (result.code !== 0) {
        return;
      }
    }
  }

  private async flushConnections(ip: string): Promise<void> {
    await this.runner.run("conntrack", ["-D", "-s", ip], { allowFailure: true });
  }
}
