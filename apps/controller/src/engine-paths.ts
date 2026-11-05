import type { PathAssignment } from "@aceswarm/shared/api-types";
import type { NetgwClient } from "./clients.ts";

/**
 * The gateway paths of one stream's engines, by engine address. The gateway blocks an address
 * that has no path. A path that is never dropped stays in the list sent to the gateway, which
 * then hands it to whichever engine gets that address next, so the paths of engines that are gone
 * (one that died, or that came back on a new address) have to be dropped.
 */
export class EnginePaths {
  private readonly netgw: NetgwClient;
  private readonly assigned = new Map<string, string>();

  constructor(netgw: NetgwClient) {
    this.netgw = netgw;
  }

  list(): PathAssignment[] {
    return [...this.assigned].map(([ip, path]) => ({ ip, path }));
  }

  has(ip: string): boolean {
    return this.assigned.has(ip);
  }

  async assign(ip: string, path: string): Promise<void> {
    await this.netgw.assign({ ip, path });
    this.assigned.set(ip, path);
  }

  /** Drops the path of an address. Never fails: the next full list sent to the gateway drops it too. */
  async drop(ip: string): Promise<void> {
    this.assigned.delete(ip);
    await this.netgw.unassign(ip).catch(() => undefined);
  }

  /** Drops the paths of every address but `ip`. */
  async keepOnly(ip: string): Promise<void> {
    for (const other of this.assigned.keys()) {
      if (other !== ip) {
        await this.drop(other);
      }
    }
  }

  async dropAll(): Promise<void> {
    for (const ip of this.assigned.keys()) {
      await this.drop(ip);
    }
  }
}
