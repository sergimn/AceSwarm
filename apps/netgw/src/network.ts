import type { CommandRunner } from "./exec.ts";
import { inSubnet } from "@aceswarm/shared/ipv4";

export interface Interfaces {
  /** Interface on the engines network (traffic to route comes in here). */
  engines: string;
  /** Interface holding the default route (the "direct" path). */
  egress: string;
}

interface IpAddress {
  ifname: string;
  addr_info?: { family?: string; local?: string }[];
}

interface IpRoute {
  dev?: string;
}

/** Finds which container interface faces the engines and which one reaches the internet. */
export async function detectInterfaces(runner: CommandRunner, engineSubnet: string): Promise<Interfaces> {
  const addressOutput = await runner.run("ip", ["-j", "-4", "address", "show"]);
  const addresses = JSON.parse(addressOutput.stdout) as IpAddress[];
  const engines = addresses.find((entry) =>
    (entry.addr_info ?? []).some((info) => info.local !== undefined && inSubnet(info.local, engineSubnet)),
  )?.ifname;
  const routeOutput = await runner.run("ip", ["-j", "-4", "route", "show", "default"]);
  const routes = JSON.parse(routeOutput.stdout) as IpRoute[];
  const egress = routes.find((route) => route.dev !== undefined && route.dev !== engines)?.dev;
  if (engines === undefined) {
    throw new Error(`no interface has an address in the engines subnet ${engineSubnet}`);
  }
  if (egress === undefined) {
    throw new Error("no default route found for the direct path");
  }
  return { engines, egress };
}

const NAT_CHAIN = "ACESWARM-NAT";
const MSS_CHAIN = "ACESWARM-MSS";
const FORWARD_CHAIN = "ACESWARM-FWD";
const INPUT_CHAIN = "ACESWARM-IN";

/**
 * Owns the gateway's iptables rules: forwarding permissions per engine (fail closed), masquerading
 * for each outgoing path and MSS clamping so TCP works through tunnels with a smaller MTU. Rules
 * live in dedicated chains, which keeps updates idempotent.
 */
export class Firewall {
  private readonly runner: CommandRunner;
  private readonly engineSubnet: string;
  private readonly command: string;

  constructor(runner: CommandRunner, engineSubnet: string, command = "iptables") {
    this.runner = runner;
    this.engineSubnet = engineSubnet;
    this.command = command;
  }

  /**
   * Stops all forwarding. Runs first thing at startup, so engines that are still running while the
   * gateway restarts cannot slip out through the direct path before their paths are known again.
   */
  async lockdown(): Promise<void> {
    await this.iptables(["-P", "FORWARD", "DROP"]);
  }

  /** Sets up the chains. `enginesIface` faces the engines, which may not open connections to the gateway itself. */
  async init(enginesIface: string): Promise<void> {
    await this.lockdown();
    await this.ensureChain("filter", INPUT_CHAIN, "INPUT");
    await this.iptables(["-F", INPUT_CHAIN]);
    await this.iptables([
      "-A",
      INPUT_CHAIN,
      "-i",
      enginesIface,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "ACCEPT",
    ]);
    await this.iptables(["-A", INPUT_CHAIN, "-i", enginesIface, "-j", "DROP"]);
    await this.ensureChain("filter", FORWARD_CHAIN, "FORWARD");
    await this.iptables(["-F", FORWARD_CHAIN]);
    // Replies to connections an engine was allowed to open.
    await this.iptables([
      "-A",
      FORWARD_CHAIN,
      "-d",
      this.engineSubnet,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "ACCEPT",
    ]);
    await this.ensureChain("nat", NAT_CHAIN, "POSTROUTING");
    await this.ensureChain("mangle", MSS_CHAIN, "FORWARD");
    await this.iptables(["-t", "mangle", "-F", MSS_CHAIN]);
    await this.iptables([
      "-t",
      "mangle",
      "-A",
      MSS_CHAIN,
      "-p",
      "tcp",
      "--tcp-flags",
      "SYN,RST",
      "SYN",
      "-j",
      "TCPMSS",
      "--clamp-mss-to-pmtu",
    ]);
  }

  /** Lets an engine open connections through one interface (its path). */
  async allow(ip: string, iface: string): Promise<void> {
    await this.iptables(["-A", FORWARD_CHAIN, ...this.engineRule(ip, iface)]);
  }

  /** Removes every accept rule of an engine, for any interface (and duplicates, if any). */
  async revoke(ip: string): Promise<void> {
    const listing = await this.runner.run(this.command, ["-w", "5", "-S", FORWARD_CHAIN]);
    const prefix = `-A ${FORWARD_CHAIN} -s ${ip}/32 `;
    for (const line of listing.stdout.split("\n")) {
      if (line.startsWith(prefix)) {
        await this.iptables(["-D", ...line.trim().split(/\s+/).slice(1)], true);
      }
    }
  }

  private engineRule(ip: string, iface: string): string[] {
    return ["-s", `${ip}/32`, "-o", iface, "-j", "ACCEPT"];
  }

  /** Masquerades engine traffic leaving through any of the given interfaces. */
  async setOutputs(interfaces: string[]): Promise<void> {
    await this.iptables(["-t", "nat", "-F", NAT_CHAIN]);
    for (const iface of interfaces) {
      await this.iptables(["-t", "nat", "-A", NAT_CHAIN, "-s", this.engineSubnet, "-o", iface, "-j", "MASQUERADE"]);
    }
  }

  private async ensureChain(table: string, chain: string, parent: string): Promise<void> {
    await this.iptables(["-t", table, "-N", chain], true);
    const exists = await this.iptables(["-t", table, "-C", parent, "-j", chain], true);
    if (!exists) {
      await this.iptables(["-t", table, "-A", parent, "-j", chain]);
    }
  }

  private async iptables(args: string[], allowFailure = false): Promise<boolean> {
    const result = await this.runner.run(this.command, ["-w", "5", ...args], { allowFailure });
    return result.code === 0;
  }
}
