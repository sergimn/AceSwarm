import { createLogger } from "@aceswarm/shared/logger";
import { createService, runService } from "@aceswarm/shared/service";
import { AcestreamClient } from "./acestream.ts";
import { NetgwClient, TranscoderClient } from "./clients.ts";
import { loadConfig } from "./config.ts";
import { DockerClient } from "./docker.ts";
import { EngineResourceMonitor } from "./engine-resources.ts";
import { EnginePlaces } from "./engine-places.ts";
import { EngineRuns } from "./engine-runs.ts";
import { EngineManager } from "./engines.ts";
import { ControllerMetrics } from "./metrics.ts";
import { Orchestrator } from "./orchestrator.ts";
import { PEER_TRAFFIC_POLL_MS, PeerTrafficMonitor } from "./peer-traffic.ts";
import { registerRoutes } from "./server.ts";
import { NetworkPolicyStore } from "./network-policy-store.ts";
import { SettingsStore } from "./settings-store.ts";
import { SharedEngines } from "./shared-engines.ts";
import { StreamStore } from "./stream-store.ts";
import { Viewers } from "./viewers.ts";
import { WireguardStore } from "./wireguard-store.ts";

const config = loadConfig();
const logger = createLogger("controller");
const service = createService({
  name: "controller",
  logger,
  bodyLimit: 64 * 1024,
  blockedClients: [config.ENGINE_IP_RANGE],
});

const docker = new DockerClient(config.DOCKER_HOST);
const ace = new AcestreamClient();
const transcoder = new TranscoderClient(config.TRANSCODER_URL);
const netgw = new NetgwClient(config.NETGW_URL);
// How long each engine ran and why it was restarted or removed: a histogram, and a log line with
// the stream, the engine's role and its path. The metrics and the places exist by the time one ends.
const engineRuns = new EngineRuns({
  observe: (kind, reason, seconds) => {
    metrics.engineLifetime.observe({ kind, reason }, seconds);
  },
  placeOf: (engine) => enginePlaces.placeOf(engine),
  logger,
});
const engines = new EngineManager(
  docker,
  ace,
  {
    stack: config.STACK_NAME,
    image: config.ENGINE_IMAGE,
    network: config.ENGINE_NETWORK,
    gatewayIp: config.ENGINE_GATEWAY_IP,
    httpPort: config.ENGINE_HTTP_PORT,
    memoryMb: config.ENGINE_MEMORY_MB,
    memoryCacheMb: config.ENGINE_MEMORY_CACHE_MB,
    cacheDir: config.ENGINE_CACHE_DIR,
    diskCacheMb: config.ENGINE_DISK_CACHE_MB,
    extraFlags: config.ENGINE_EXTRA_FLAGS,
    dns: config.ENGINE_DNS,
    readyTimeoutMs: config.ENGINE_READY_TIMEOUT_SECONDS * 1000,
  },
  logger,
  engineRuns,
);

const engineResources: EngineResourceMonitor = new EngineResourceMonitor(
  docker,
  {
    stack: config.STACK_NAME,
    network: config.ENGINE_NETWORK,
    onOomKill: (stream) => {
      metrics.engineOomKills.inc({ stream });
    },
    runs: engineRuns,
  },
  logger,
);

// What each engine exchanged with each of its peers, which only the metrics show.
const peerTraffic = new PeerTrafficMonitor(netgw);

// What each engine container is for, which the engine gauges carry as labels and the log says of
// an engine that is restarted or removed.
const enginePlaces = new EnginePlaces(() => orchestrator.keptEngines());

// The metrics read the orchestrator lazily at scrape time, after it exists.
const metrics: ControllerMetrics = new ControllerMetrics(
  service.registry,
  () => orchestrator.snapshot(),
  () => engineResources.latest(),
  {
    viewers: () => orchestrator.viewers(),
    sharedEngines: () => sharedEngines.view(),
    engines: () => engineResources.running(),
    runningSince: (stream) => orchestrator.runningSince(stream),
    enginePlaces: (engines, streams) => enginePlaces.resolve(engines, streams),
    peerTraffic: (engineIp) => peerTraffic.of(engineIp),
  },
);
const sharedEngines = new SharedEngines({
  engines,
  netgw,
  metrics,
  logger,
  settings: {
    maxFailures: config.SHARED_ENGINE_MAX_FAILURES,
    failureWindowMs: config.SHARED_ENGINE_FAILURE_WINDOW_SECONDS * 1000,
    // Every stream gets a handover's time to leave a replaced engine, plus a minute to retry.
    // Long enough for a stream whose first handover timed out to try a second time.
    retireTimeoutMs: (2 * config.HANDOVER_TIMEOUT_SECONDS + 60) * 1000,
    // Long enough for a stream whose move to the engine failed to try again on it.
    idleTimeoutMs: 120_000,
  },
});
const wireguard = new WireguardStore(config.DATA_DIR);
const orchestrator: Orchestrator = new Orchestrator({
  store: new StreamStore(config.DATA_DIR),
  wireguard,
  policy: new NetworkPolicyStore(wireguard.directory),
  settingsStore: new SettingsStore(config.DATA_DIR),
  shared: sharedEngines,
  viewers: new Viewers({ pingMs: config.VIEWER_PING_SECONDS * 1000 }),
  engines,
  ace,
  transcoder,
  netgw,
  metrics,
  logger,
  maxKeptEngines: config.MAX_KEPT_ENGINES,
  thumbnailsOnly: config.LOW_CPU_PREVIEWS,
  standby: {
    maxPaths: config.STANDBY_MAX_PATHS,
    failoverAfterMs: config.STANDBY_FAILOVER_SECONDS * 1000,
    // A standby gets as long as a starting stream to deliver its first data.
    warmupMs: config.STARTUP_GRACE_SECONDS * 1000,
    hotWithinMs: 10_000,
    downGraceMs: 120_000,
    policy: {
      baseDelayMs: config.RECOVERY_BASE_DELAY_SECONDS * 1000,
      maxDelayMs: config.RECOVERY_MAX_DELAY_SECONDS * 1000,
    },
  },
  settings: {
    tickMs: config.TICK_MS,
    stallAfterMs: config.STALL_SECONDS * 1000,
    startupGraceMs: config.STARTUP_GRACE_SECONDS * 1000,
    recoveryBaseDelayMs: config.RECOVERY_BASE_DELAY_SECONDS * 1000,
    recoveryMaxDelayMs: config.RECOVERY_MAX_DELAY_SECONDS * 1000,
    staleSourceRetryMs: config.STALE_SOURCE_RETRY_SECONDS * 1000,
    handoverTimeoutMs: config.HANDOVER_TIMEOUT_SECONDS * 1000,
    pathStrategy: config.PATH_STRATEGY,
    pathMinDwellMs: config.PATH_MIN_DWELL_SECONDS * 1000,
  },
});

// Listening doesn't wait for the orchestrator: after a restart, players get their segments back
// sooner (the API waits for it, see `ServerOptions.ready`).
const started = orchestrator.start();
await registerRoutes(service, orchestrator, {
  uiDir: config.UI_DIR,
  transcoderUrl: config.TRANSCODER_URL,
  ready: started,
});
// One sample at a time: with a slow Docker API, samples would pile up and an older one could
// finish last, putting back an old engine count or clearing a fresh one.
const engineSampling = { busy: false };
const sampleEngines = (): void => {
  if (engineSampling.busy) {
    return;
  }
  engineSampling.busy = true;
  void engineResources
    .sample()
    .then(() => {
      // Not only at a scrape: the log tells an engine's place also when nothing collects metrics.
      enginePlaces.resolve(engineResources.latest(), orchestrator.snapshot().streams);
    })
    .catch((error: unknown) => {
      logger.debug({ err: error }, "could not sample engine resources");
    })
    .finally(() => {
      engineSampling.busy = false;
    });
};
sampleEngines();
const engineResourceTimer = setInterval(sampleEngines, config.ENGINE_STATS_SECONDS * 1000);
// A request gives up before the next one is due, so they never pile up.
const peerTrafficTimer = setInterval(() => {
  void peerTraffic.sample().catch((error: unknown) => {
    logger.debug({ err: error }, "could not get the engines' peer traffic from the gateway");
  });
}, PEER_TRAFFIC_POLL_MS);
await runService(service, config.PORT, logger, async () => {
  clearInterval(engineResourceTimer);
  clearInterval(peerTrafficTimer);
  await orchestrator.stop();
});
await started;
logger.info(
  {
    port: config.PORT,
    strategy: config.PATH_STRATEGY,
    lowCpuPreviews: config.LOW_CPU_PREVIEWS,
    // Where the engines started from now on keep their stream cache.
    engineCache: config.ENGINE_CACHE_DIR === "" ? "memory" : config.ENGINE_CACHE_DIR,
  },
  "controller ready",
);
