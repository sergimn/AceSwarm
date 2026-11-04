import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@aceswarm/shared/logger";
import { isIpv4Cidr, parseWireguardConfig, toSetconf, type WireguardConfig } from "@aceswarm/shared/wireguard";
import { describeError } from "@aceswarm/shared/http";
import type { CommandRunner } from "./exec.ts";

export interface Tunnel {
  profile: string;
  pathId: string;
  iface: string;
  table: number;
  /** IPv4 address of the tunnel; probes use it as source so they follow the tunnel's table. */
  address: string | undefined;
  config: WireguardConfig | undefined;
  text: string;
  error: string | null;
}

const TABLE_BASE = 100;
const PROBE_RULE_PRIORITY = 900;
const DEFAULT_MTU = 1420;

export function pathIdFor(profile: string): string {
  return `wg:${profile}`;
}

/**
 * Brings WireGuard tunnels up and down to match the profile directory. Each tunnel gets an
 * interface `aswg<N>` and its own routing table `100+N` holding a default route through the
 * tunnel and an unreachable fallback, so traffic routed to a tunnel never leaks elsewhere.
 */
export class TunnelManager {
  private readonly runner: CommandRunner;
  private readonly directory: string;
  private readonly runtimeDir: string;
  private readonly logger: Logger;
  private readonly userspaceFallback: boolean;
  private readonly tunnels = new Map<string, Tunnel>();

  constructor(runner: CommandRunner, directory: string, runtimeDir: string, logger: Logger, userspaceFallback = false) {
    this.runner = runner;
    this.directory = directory;
    this.runtimeDir = runtimeDir;
    this.logger = logger.child({ component: "tunnels" });
    this.userspaceFallback = userspaceFallback;
  }

  list(): Tunnel[] {
    return this.tunnels
      .values()
      .toArray()
      .toSorted((a, b) => a.profile.localeCompare(b.profile));
  }

  byPath(pathId: string): Tunnel | undefined {
    return this.list().find((tunnel) => tunnel.pathId === pathId);
  }

  /** Removes interfaces left over from a previous run of the gateway. */
  async cleanup(): Promise<void> {
    const output = await this.runner.run("ip", ["-j", "link", "show"]);
    const links = JSON.parse(output.stdout) as { ifname: string }[];
    for (const link of links) {
      if (/^aswg\d+$/.test(link.ifname)) {
        await this.runner.run("ip", ["link", "del", link.ifname], { allowFailure: true });
      }
    }
  }

  /** Reads the profile directory and adds, replaces or removes tunnels to match it. */
  async reconcile(): Promise<{ added: string[]; removed: string[] }> {
    const profiles = await this.readProfiles();
    const added: string[] = [];
    const removed: string[] = [];
    for (const tunnel of this.list()) {
      const text = profiles.get(tunnel.profile);
      if (text !== undefined && text === tunnel.text) {
        continue;
      }
      await this.down(tunnel);
      this.tunnels.delete(tunnel.profile);
      removed.push(tunnel.profile);
    }
    for (const [profile, text] of profiles) {
      if (this.tunnels.has(profile)) {
        continue;
      }
      const tunnel = await this.up(profile, text);
      this.tunnels.set(profile, tunnel);
      added.push(profile);
    }
    if (added.length > 0 || removed.length > 0) {
      this.logger.info({ added, removed }, "tunnels reconciled");
    }
    return { added, removed };
  }

  private async readProfiles(): Promise<Map<string, string>> {
    const profiles = new Map<string, string>();
    const files = await readdir(this.directory).catch(() => [] as string[]);
    const valid = files
      .filter((name) => /^[a-z0-9][a-z0-9_-]{0,31}\.conf$/.test(name))
      .toSorted((a, b) => a.localeCompare(b));
    for (const file of valid) {
      profiles.set(file.slice(0, -".conf".length), await readFile(join(this.directory, file), "utf8"));
    }
    return profiles;
  }

  private freeSlot(): number {
    const used = new Set(this.list().map((tunnel) => tunnel.table - TABLE_BASE));
    let slot = 0;
    while (used.has(slot)) {
      slot += 1;
    }
    return slot;
  }

  private async up(profile: string, text: string): Promise<Tunnel> {
    const slot = this.freeSlot();
    const tunnel: Tunnel = {
      profile,
      pathId: pathIdFor(profile),
      iface: `aswg${String(slot)}`,
      table: TABLE_BASE + slot,
      address: undefined,
      config: undefined,
      text,
      error: null,
    };
    const parsed = parseWireguardConfig(text);
    if (!parsed.ok) {
      tunnel.error = parsed.errors.join("; ");
      this.logger.warn({ profile, error: tunnel.error }, "invalid profile");
      return tunnel;
    }
    tunnel.config = parsed.config;
    try {
      await this.configure(tunnel, parsed.config);
    } catch (error) {
      tunnel.error = describeError(error);
      this.logger.error({ profile, error: tunnel.error }, "could not bring tunnel up");
    }
    return tunnel;
  }

  private async configure(tunnel: Tunnel, config: WireguardConfig): Promise<void> {
    const ip = (args: string[]): Promise<unknown> => this.runner.run("ip", args);
    await this.runner.run("ip", ["link", "del", tunnel.iface], { allowFailure: true });
    await this.createInterface(tunnel.iface);

    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const setconfPath = join(this.runtimeDir, `${tunnel.iface}.conf`);
    await writeFile(setconfPath, toSetconf(config), { mode: 0o600 });
    try {
      await this.runner.run("wg", ["setconf", tunnel.iface, setconfPath]);
    } finally {
      await rm(setconfPath, { force: true });
    }

    const ipv4 = config.iface.addresses.filter((address) => isIpv4Cidr(address));
    for (const address of ipv4) {
      await ip(["-4", "address", "add", address.includes("/") ? address : `${address}/32`, "dev", tunnel.iface]);
    }
    tunnel.address = ipv4[0]?.split("/", 1)[0];
    await ip(["link", "set", "dev", tunnel.iface, "mtu", String(config.iface.mtu ?? DEFAULT_MTU), "up"]);
    const table = String(tunnel.table);
    await ip(["-4", "route", "replace", "default", "dev", tunnel.iface, "table", table]);
    await ip(["-4", "route", "replace", "unreachable", "default", "metric", "4096", "table", table]);
    if (tunnel.address !== undefined) {
      await this.runner.run(
        "ip",
        ["-4", "rule", "del", "from", tunnel.address, "priority", String(PROBE_RULE_PRIORITY)],
        { allowFailure: true },
      );
      await ip(["-4", "rule", "add", "from", tunnel.address, "lookup", table, "priority", String(PROBE_RULE_PRIORITY)]);
    }
    this.logger.info({ profile: tunnel.profile, iface: tunnel.iface, table: tunnel.table }, "tunnel up");
  }

  /**
   * Creates the WireGuard interface with the kernel module, or with wireguard-go (userspace) when
   * the module is missing and the fallback is enabled.
   */
  private async createInterface(iface: string): Promise<void> {
    const kernel = await this.runner.run("ip", ["link", "add", "dev", iface, "type", "wireguard"], {
      allowFailure: true,
    });
    if (kernel.code === 0) {
      return;
    }
    if (!this.userspaceFallback) {
      throw new Error(`kernel WireGuard is not available: ${kernel.stderr.trim()}`);
    }
    this.logger.warn({ iface }, "kernel WireGuard is not available; using wireguard-go");
    // Without LOG_LEVEL, wireguard-go detaches from our output pipes once the interface exists.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "LOG_LEVEL"));
    await this.runner.run("wireguard-go", [iface], { env });
  }

  private async down(tunnel: Tunnel): Promise<void> {
    if (tunnel.address !== undefined) {
      await this.runner.run(
        "ip",
        ["-4", "rule", "del", "from", tunnel.address, "priority", String(PROBE_RULE_PRIORITY)],
        { allowFailure: true },
      );
    }
    await this.runner.run("ip", ["-4", "route", "flush", "table", String(tunnel.table)], { allowFailure: true });
    await this.runner.run("ip", ["link", "del", tunnel.iface], { allowFailure: true });
    this.logger.info({ profile: tunnel.profile, iface: tunnel.iface }, "tunnel down");
  }
}
