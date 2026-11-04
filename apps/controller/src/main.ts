import { createLogger } from "@aceswarm/shared/logger";
import { createService, runService } from "@aceswarm/shared/service";
import { AcestreamClient } from "./acestream.ts";
import { NetgwClient, TranscoderClient } from "./clients.ts";
import { loadConfig } from "./config.ts";
import { DockerClient } from "./docker.ts";
import { EngineResourceMonitor } from "./engine-resources.ts";
import { EngineManager } from "./engines.ts";
import { ControllerMetrics } from "./metrics.ts";
import { Orchestrator } from "./orchestrator.ts";
import { registerRoutes } from "./server.ts";
import { StreamStore } from "./stream-store.ts";
import { WireguardStore } from "./wireguard-store.ts";

const config = loadConfig();
const logger = createLogger("controller");
const service = createService({ name: "controller", logger, bodyLimit: 64 * 1024 });

const docker = new DockerClient(config.DOCKER_HOST);
const ace = new AcestreamClient();
const transcoder = new TranscoderClient(config.TRANSCODER_URL);
const netgw = new NetgwClient(config.NETGW_URL);
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
    extraFlags: config.ENGINE_EXTRA_FLAGS,
    dns: config.ENGINE_DNS,
    readyTimeoutMs: config.ENGINE_READY_TIMEOUT_SECONDS * 1000,
  },
  logger,
);

const engineResources: EngineResourceMonitor = new EngineResourceMonitor(
  docker,
  {
    stack: config.STACK_NAME,
    onOomKill: (stream) => {
      metrics.engineOomKills.inc({ stream });
    },
  },
  logger,
);

// The metrics read the orchestrator lazily at scrape time, after it exists.
const metrics: ControllerMetrics = new ControllerMetrics(
  service.registry,
  () => orchestrator.snapshot(),
  () => engineResources.latest(),
);
const orchestrator: Orchestrator = new Orchestrator({
  store: new StreamStore(config.DATA_DIR),
  wireguard: new WireguardStore(config.DATA_DIR),
  engines,
  ace,
  transcoder,
  netgw,
  metrics,
  logger,
  settings: {
    tickMs: config.TICK_MS,
    stallAfterMs: config.STALL_SECONDS * 1000,
    startupGraceMs: config.STARTUP_GRACE_SECONDS * 1000,
    recoveryBaseDelayMs: config.RECOVERY_BASE_DELAY_SECONDS * 1000,
    recoveryMaxDelayMs: config.RECOVERY_MAX_DELAY_SECONDS * 1000,
    handoverTimeoutMs: config.HANDOVER_TIMEOUT_SECONDS * 1000,
    pathStrategy: config.PATH_STRATEGY,
    pathHysteresis: config.PATH_HYSTERESIS,
    pathMinDwellMs: config.PATH_MIN_DWELL_SECONDS * 1000,
  },
});

await registerRoutes(service, orchestrator, { uiDir: config.UI_DIR, transcoderUrl: config.TRANSCODER_URL });
await orchestrator.start();
const sampleEngines = (): void => {
  void engineResources.sample().catch((error: unknown) => {
    logger.debug({ err: error }, "could not sample engine resources");
  });
};
sampleEngines();
const engineResourceTimer = setInterval(sampleEngines, config.ENGINE_STATS_SECONDS * 1000);
await runService(service, config.PORT, logger, async () => {
  clearInterval(engineResourceTimer);
  await orchestrator.stop();
});
logger.info({ port: config.PORT, strategy: config.PATH_STRATEGY }, "controller ready");
