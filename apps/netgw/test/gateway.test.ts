import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PathStatus } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it, onTestFinished } from "vitest";
import { Gateway } from "../src/gateway.ts";
import type { Firewall } from "../src/network.ts";
import type { PeerTracker } from "../src/peers.ts";
import type { Prober, ProbeTarget } from "../src/probe.ts";
import type { Router } from "../src/router.ts";
import type { Tunnel, TunnelManager } from "../src/tunnels.ts";

const tunnel = { profile: "vpn", pathId: "wg:vpn", iface: "wg-vpn", address: "10.13.13.2", error: null } as Tunnel;

/** A gateway whose parts record what they are asked to do, in order. */
async function setup(policy: string | undefined, reconcile: () => Promise<void> = () => Promise.resolve()) {
  const policyDir = await mkdtemp(join(tmpdir(), "aceswarm-gateway-"));
  onTestFinished(async () => {
    await rm(policyDir, { recursive: true, force: true });
  });
  if (policy !== undefined) {
    await writeFile(join(policyDir, "policy.json"), policy);
  }
  const events: string[] = [];
  const outputs: string[][] = [];
  const tunnels = {
    reconcile: async () => {
      events.push("reconcile");
      await reconcile();
    },
    list: () => [tunnel],
    cleanup: () => Promise.resolve(),
  } as unknown as TunnelManager;
  const router = {
    setDirectAllowed: (allowed: boolean) => {
      events.push(`direct ${allowed ? "allowed" : "refused"}`);
    },
    reapply: () => {
      events.push("reapply");
      return Promise.resolve();
    },
  } as unknown as Router;
  const firewall = {
    init: () => Promise.resolve(),
    setOutputs: (interfaces: string[]) => {
      events.push("outputs");
      outputs.push(interfaces);
      return Promise.resolve();
    },
  } as unknown as Firewall;
  const prober = {
    probe: (target: ProbeTarget) => Promise.resolve({ id: target.id, up: true } as PathStatus),
  } as unknown as Prober;
  const gateway = new Gateway({
    tunnels,
    router,
    peers: {} as PeerTracker,
    firewall,
    prober,
    interfaces: { engines: "eth1", egress: "eth0" },
    logger: createLogger("test", "silent"),
    policyDir,
  });
  return { gateway, events, outputs };
}

describe("Gateway.reload", () => {
  it("lets engines out the direct interface while WireGuard only is off", async () => {
    const { gateway, outputs } = await setup(undefined);
    await gateway.reload();
    expect(gateway.policy()).toEqual({ wireguardOnly: false });
    expect(outputs).toEqual([["eth0", "wg-vpn"]]);
  });

  it("applies WireGuard only before the tunnels and routing, and leaves the direct interface out", async () => {
    const { gateway, events, outputs } = await setup(JSON.stringify({ version: 1, wireguardOnly: true }));
    await gateway.reload();
    expect(gateway.policy()).toEqual({ wireguardOnly: true });
    expect(events).toEqual(["direct refused", "reconcile", "outputs", "reapply"]);
    expect(outputs).toEqual([["wg-vpn"]]);
  });

  it("still applies the policy and routing when a profile can't be applied", async () => {
    const { gateway, events, outputs } = await setup(JSON.stringify({ version: 1, wireguardOnly: true }), () =>
      Promise.reject(new Error("bad profile")),
    );
    await expect(gateway.reload()).rejects.toThrow("bad profile");
    expect(events).toEqual(["direct refused", "reconcile", "outputs", "reapply"]);
    expect(outputs).toEqual([["wg-vpn"]]);
  });

  it("keeps the direct interface off when the policy file can't be understood", async () => {
    const { gateway, outputs } = await setup("{ broken");
    await gateway.reload();
    expect(gateway.policy()).toEqual({ wireguardOnly: true });
    expect(outputs).toEqual([["wg-vpn"]]);
  });
});
