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

/**
 * Policy routing per engine: `ip rule add from <engine> lookup <tunnel table>`. Engines without a
 * rule use the main table, which is the direct path. Changing the path flushes the engine's
 * tracked connections so they are re-established (and re-NATed) through the new path.
 */
export class Router {
  private readonly runner: CommandRunner;
  private readonly subnet: string;
  private readonly tunnel: (pathId: string) => Tunnel | undefined;
  private readonly logger: Logger;
  private readonly assignments = new Map<string, string>();

  constructor(runner: CommandRunner, subnet: string, tunnel: (pathId: string) => Tunnel | undefined, logger: Logger) {
    this.runner = runner;
    this.subnet = subnet;
    this.tunnel = tunnel;
    this.logger = logger.child({ component: "router" });
  }

  list(): PathAssignment[] {
    return [...this.assignments].map(([ip, path]) => ({ ip, path }));
  }

  pathOf(ip: string): string {
    return this.assignments.get(ip) ?? DIRECT_PATH;
  }

  isEngineIp(ip: string): boolean {
    return inSubnet(ip, this.subnet);
  }

  async assign(ip: string, path: string): Promise<void> {
    if (!this.isEngineIp(ip)) {
      throw new Error(`${ip} is not on the engines network ${this.subnet}`);
    }
    const tunnel = path === DIRECT_PATH ? undefined : this.tunnel(path);
    if (path !== DIRECT_PATH && tunnel === undefined) {
      throw new UnknownPathError(path);
    }
    const previous = this.assignments.get(ip);
    await this.clearRules(ip);
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
    this.assignments.set(ip, path);
    if (previous !== undefined && previous !== path) {
      await this.flushConnections(ip);
    }
    if (previous !== path) {
      this.logger.info({ ip, from: previous ?? DIRECT_PATH, to: path }, "engine path assigned");
    }
  }

  async unassign(ip: string): Promise<void> {
    if (!this.assignments.has(ip)) {
      return;
    }
    await this.clearRules(ip);
    this.assignments.delete(ip);
    await this.flushConnections(ip);
  }

  /** Re-applies every assignment after tunnels changed; engines on removed paths go direct. */
  async reapply(): Promise<void> {
    // Iterate over a copy: assign() writes to the map, and a Map iterator also visits keys that
    // are re-inserted while it runs, which would never end.
    const current = [...this.assignments];
    for (const [ip, path] of current) {
      const target = path === DIRECT_PATH || this.tunnel(path) !== undefined ? path : DIRECT_PATH;
      await this.assign(ip, target);
    }
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
