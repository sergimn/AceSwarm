import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "@prometheus-io/client";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AcestreamClient } from "../src/acestream.ts";
import type { NetgwClient, TranscoderClient } from "../src/clients.ts";
import type { EngineManager } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import { NetworkPolicyStore } from "../src/network-policy-store.ts";
import { NetworkPolicyError, Orchestrator } from "../src/orchestrator.ts";
import { StreamStore } from "../src/stream-store.ts";
import { WireguardStore } from "../src/wireguard-store.ts";

// Throwaway, syntactically valid keys (not real credentials), the same as the shared tests use.
const PRIVATE = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const PUBLIC = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
const PROFILE = `[Interface]
PrivateKey = ${PRIVATE}
Address = 10.13.13.2/32

[Peer]
PublicKey = ${PUBLIC}
Endpoint = 198.51.100.20:51820
AllowedIPs = 0.0.0.0/0
`;

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aceswarm-policy-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/** An orchestrator with real stores in a temporary directory and a fake gateway. */
async function setup() {
  const dataDir = await tempDirectory();
  const wireguard = new WireguardStore(dataDir);
  await wireguard.init();
  const policy = new NetworkPolicyStore(wireguard.directory);
  await policy.load();
  const gateway = { reloads: 0 };
  const netgw = {
    reload: () => {
      gateway.reloads += 1;
      return Promise.resolve();
    },
    paths: () => Promise.resolve([]),
  } as unknown as NetgwClient;
  const orchestrator = new Orchestrator({
    store: new StreamStore(dataDir),
    wireguard,
    policy,
    engines: {} as EngineManager,
    ace: {} as AcestreamClient,
    transcoder: {} as TranscoderClient,
    netgw,
    metrics: new ControllerMetrics(new Registry(), () => ({ streams: [], paths: [] })),
    logger: createLogger("test", "silent"),
    settings: {
      tickMs: 1000,
      stallAfterMs: 20_000,
      startupGraceMs: 60_000,
      recoveryBaseDelayMs: 1000,
      recoveryMaxDelayMs: 60_000,
      handoverTimeoutMs: 30_000,
      pathStrategy: "sticky-best",
      pathMinDwellMs: 300_000,
    },
  });
  return { orchestrator, wireguard, gateway, policyFile: join(wireguard.directory, "policy.json") };
}

describe("WireGuard only", () => {
  it("can't be turned on without a WireGuard profile", async () => {
    const { orchestrator, gateway } = await setup();
    await expect(orchestrator.setNetworkPolicy({ wireguardOnly: true })).rejects.toThrow(NetworkPolicyError);
    expect(orchestrator.snapshot().wireguardOnly).toBe(false);
    expect(gateway.reloads).toBe(0);
  });

  it("is saved where the gateway reads it, and the gateway reloads it", async () => {
    const { orchestrator, gateway, policyFile } = await setup();
    await orchestrator.saveProfile("vpn", PROFILE);
    const reloads = gateway.reloads;

    expect(await orchestrator.setNetworkPolicy({ wireguardOnly: true })).toEqual({ wireguardOnly: true });
    expect(orchestrator.snapshot().wireguardOnly).toBe(true);
    expect(JSON.parse(await readFile(policyFile, "utf8"))).toEqual({ version: 1, wireguardOnly: true });
    expect(gateway.reloads).toBe(reloads + 1);

    // The policy survives a restart.
    const restarted = new NetworkPolicyStore(join(policyFile, ".."));
    expect(await restarted.load()).toBeNull();
    expect(restarted.get()).toEqual({ wireguardOnly: true });
  });

  it("keeps the last profile while it is on", async () => {
    const { orchestrator } = await setup();
    await orchestrator.saveProfile("vpn-a", PROFILE);
    await orchestrator.saveProfile("vpn-b", PROFILE);
    await orchestrator.setNetworkPolicy({ wireguardOnly: true });

    expect(await orchestrator.removeProfile("vpn-a")).toBe(true);
    await expect(orchestrator.removeProfile("vpn-b")).rejects.toThrow("Turn WireGuard only off first");
    expect((await orchestrator.listProfiles()).map((profile) => profile.name)).toEqual(["vpn-b"]);

    await orchestrator.setNetworkPolicy({ wireguardOnly: false });
    expect(await orchestrator.removeProfile("vpn-b")).toBe(true);
  });

  it("checks profiles and removals one at a time", async () => {
    const { orchestrator } = await setup();
    await orchestrator.saveProfile("vpn", PROFILE);
    // Turning it on and removing the only profile at once: one of them has to fail.
    const results = await Promise.allSettled([
      orchestrator.setNetworkPolicy({ wireguardOnly: true }),
      orchestrator.removeProfile("vpn"),
    ]);
    const profiles = await orchestrator.listProfiles();
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(profiles).toHaveLength(1);
    expect(orchestrator.snapshot().wireguardOnly).toBe(true);
  });

  it("stays on when the policy file can't be understood", async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, "policy.json"), "{ broken");
    const store = new NetworkPolicyStore(directory);
    expect(await store.load()).toContain("not valid JSON");
    expect(store.get()).toEqual({ wireguardOnly: true });
  });
});
