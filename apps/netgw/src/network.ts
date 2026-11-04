import type { CommandRunner } from "./exec.ts";
import { inSubnet } from "./ipv4.ts";

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

/**
 * Owns the gateway's iptables rules: masquerading for each outgoing path and MSS clamping so
 * TCP works through tunnels with a smaller MTU. Rules live in dedicated chains that are rebuilt
 * as a whole, which keeps updates idempotent.
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

  async init(): Promise<void> {
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
