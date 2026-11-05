import { expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../src/exec.ts";
import { Firewall, PRIVATE_NETWORKS } from "../src/network.ts";

/** Records the iptables rules the firewall adds to the forwarding chains. */
function recorder() {
  const rules: string[] = [];
  const runner: CommandRunner = {
    run: (_command: string, args: string[]): Promise<CommandResult> => {
      const rule = args.slice(2).join(" ");
      if (rule.startsWith("-A ACESWARM-FWD") || rule.startsWith("-A ACESWARM-DST")) {
        rules.push(rule);
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { runner, rules };
}

it("drops engine connections to private addresses before any engine is allowed out", async () => {
  const { runner, rules } = recorder();
  const firewall = new Firewall(runner, "172.31.250.0/24");
  await firewall.init("eth2");
  await firewall.allow("172.31.250.130", "eth0");

  const jump = rules.indexOf("-A ACESWARM-FWD -s 172.31.250.0/24 -j ACESWARM-DST");
  const accept = rules.indexOf("-A ACESWARM-FWD -s 172.31.250.130/32 -o eth0 -j ACCEPT");
  expect(jump).toBeGreaterThan(-1);
  expect(accept).toBeGreaterThan(jump);
  // Rootless Podman's address for the host, where the published ports are.
  expect(PRIVATE_NETWORKS).toContain("169.254.0.0/16");
  for (const network of PRIVATE_NETWORKS) {
    expect(rules).toContain(`-A ACESWARM-DST -d ${network} -j DROP`);
  }
  expect(rules.some((rule) => rule.includes("RETURN"))).toBe(false);
});

it("lets engines reach the private networks listed as allowed", async () => {
  const { runner, rules } = recorder();
  const firewall = new Firewall(runner, "172.31.250.0/24", "iptables", ["192.168.1.0/24"]);
  await firewall.init("eth2");

  const allowed = rules.indexOf("-A ACESWARM-DST -d 192.168.1.0/24 -j RETURN");
  expect(allowed).toBeGreaterThan(-1);
  expect(allowed).toBeLessThan(rules.indexOf("-A ACESWARM-DST -d 192.168.0.0/16 -j DROP"));
});
