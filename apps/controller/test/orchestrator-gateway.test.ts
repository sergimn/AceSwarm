import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "@prometheus-io/client";
import type { PathStatus } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { expect, onTestFinished, test, vi } from "vitest";
import type { AcestreamClient } from "../src/acestream.ts";
import type { NetgwClient, TranscoderClient } from "../src/clients.ts";
import type { EngineManager } from "../src/engines.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import { NetworkPolicyStore } from "../src/network-policy-store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { SettingsStore } from "../src/settings-store.ts";
import { SharedEngines } from "../src/shared-engines.ts";
import { StreamStore } from "../src/stream-store.ts";
import { Viewers } from "../src/viewers.ts";
import { WireguardStore } from "../src/wireguard-store.ts";

function path(id: string, up: boolean): PathStatus {
  return {
    id,
    kind: id === "direct" ? "direct" : "wireguard",
    label: id === "direct" ? "Direct" : id.replace("wg:", ""),
    up,
    rttMs: up ? 20 : null,
    loss: up ? 0 : null,
    handshakeAgeSeconds: null,
    score: up ? 0.9 : 0,
    lastProbeAt: null,
    error: null,
  };
}

/** An orchestrator without streams, whose network gateway answers with `answer` until it is told to fail. */
async function orchestratorWithGateway(answer: PathStatus[]) {
  const dataDir = await mkdtemp(join(tmpdir(), "aceswarm-gateway-"));
  const gateway = { failing: false, answer, syncs: 0 };
  const netgw = {
    paths: () => (gateway.failing ? Promise.reject(new Error("timed out")) : Promise.resolve(gateway.answer)),
    sync: () => {
      gateway.syncs += 1;
      return Promise.resolve([]);
    },
    reload: () => Promise.resolve(),
  } as unknown as NetgwClient;
  const engines = {
    ensureImage: () => Promise.resolve(),
    removeOrphans: () => Promise.resolve(0),
    find: () => Promise.resolve([]),
  } as unknown as EngineManager;
  const metrics = new ControllerMetrics(new Registry(), () => ({ streams: [], paths: [] }));
  const logger = createLogger("test", "silent");
  const wireguard = new WireguardStore(dataDir);
  const orchestrator = new Orchestrator({
    store: new StreamStore(dataDir),
    wireguard,
    policy: new NetworkPolicyStore(wireguard.directory),
    settingsStore: new SettingsStore(dataDir),
    shared: new SharedEngines({
      engines,
      netgw,
      metrics,
      logger,
      settings: { maxFailures: 2, failureWindowMs: 60_000, retireTimeoutMs: 60_000, idleTimeoutMs: 30_000 },
    }),
    viewers: new Viewers({ pingMs: 60_000 }),
    engines,
    ace: {} as unknown as AcestreamClient,
    transcoder: {} as unknown as TranscoderClient,
    netgw,
    metrics,
    logger,
    settings: {
      tickMs: 5,
      stallAfterMs: 20_000,
      startupGraceMs: 60_000,
      recoveryBaseDelayMs: 1000,
      recoveryMaxDelayMs: 60_000,
      handoverTimeoutMs: 30_000,
      pathStrategy: "sticky-best",
      pathMinDwellMs: 300_000,
    },
    pathPollMs: 5,
    stopWaitMs: 500,
  });
  onTestFinished(async () => {
    await orchestrator.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { orchestrator, gateway };
}

test("a gateway that stops answering leaves the paths it last reported and says it is unreachable", async () => {
  const { orchestrator, gateway } = await orchestratorWithGateway([path("direct", true), path("wg:mullvad-de", true)]);
  await orchestrator.start();
  expect(orchestrator.snapshot()).toMatchObject({
    gatewayReachable: true,
    paths: [
      { id: "direct", up: true },
      { id: "wg:mullvad-de", up: true },
    ],
  });

  gateway.failing = true;
  await vi.waitFor(() => {
    expect(orchestrator.snapshot().gatewayReachable).toBe(false);
  });
  // Not "0 paths": they are there, only their health is unknown.
  expect(orchestrator.snapshot().paths.map((candidate) => candidate.id)).toEqual(["direct", "wg:mullvad-de"]);

  // The controller itself still acts on what the gateway says now, not on its last answer: it
  // sends no assignments while the gateway is away (they are sent after each answer).
  const syncs = gateway.syncs;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(gateway.syncs).toBe(syncs);

  // The next answer is the truth again, whatever the last one was.
  gateway.answer = [path("direct", true), path("wg:mullvad-de", false)];
  gateway.failing = false;
  await vi.waitFor(() => {
    expect(orchestrator.snapshot()).toMatchObject({
      gatewayReachable: true,
      paths: [
        { id: "direct", up: true },
        { id: "wg:mullvad-de", up: false },
      ],
    });
  });
});

test("a gateway that never answered has no paths to show, and says it is unreachable", async () => {
  const { orchestrator, gateway } = await orchestratorWithGateway([path("direct", true)]);
  gateway.failing = true;
  await orchestrator.start();
  expect(orchestrator.snapshot()).toMatchObject({ gatewayReachable: false, paths: [] });
});
