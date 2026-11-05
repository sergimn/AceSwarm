import { createLogger } from "@aceswarm/shared/logger";
import { createService, runService } from "@aceswarm/shared/service";
import { loadConfig } from "./config.ts";
import { SystemRunner } from "./exec.ts";
import { Gateway } from "./gateway.ts";
import { GeoIpDatabase, StaticGeoLookup } from "./geoip.ts";
import { detectInterfaces, Firewall } from "./network.ts";
import { PeerTracker } from "./peers.ts";
import { Prober } from "./probe.ts";
import { Router } from "./router.ts";
import { registerMetrics, registerRoutes } from "./server.ts";
import { TunnelManager } from "./tunnels.ts";

const config = loadConfig();
const logger = createLogger("netgw");
const runner = new SystemRunner();

const firewall = new Firewall(runner, config.ENGINE_SUBNET, config.IPTABLES, config.ENGINE_ALLOWED_PRIVATE);
await firewall.lockdown();
const interfaces = await detectInterfaces(runner, config.ENGINE_SUBNET);
logger.info(interfaces, "interfaces detected");

const geo = new GeoIpDatabase(config.GEOIP_DB, logger);
const peerGeo = new StaticGeoLookup(StaticGeoLookup.parse(config.GEOIP_STATIC), geo);
const tunnels = new TunnelManager(
  runner,
  config.WIREGUARD_DIR,
  config.RUNTIME_DIR,
  logger,
  config.WIREGUARD_USERSPACE_FALLBACK,
);
const gateway = new Gateway({
  tunnels,
  router: new Router({
    runner,
    subnet: config.ENGINE_SUBNET,
    directIface: interfaces.egress,
    tunnel: (pathId) => tunnels.byPath(pathId),
    firewall,
    logger,
  }),
  peers: new PeerTracker(
    runner,
    peerGeo,
    config.ENGINE_SUBNET,
    config.IGNORED_PEER_PORTS.map((port) => Number.parseInt(port, 10)),
  ),
  firewall,
  prober: new Prober(runner, config.PROBE_TARGETS, config.HANDSHAKE_MAX_AGE_SECONDS),
  interfaces,
  logger,
  policyDir: config.WIREGUARD_DIR,
});

let ready = false;
const service = createService({
  name: "netgw",
  logger,
  blockedClients: [config.ENGINE_SUBNET],
  health: () => (ready ? undefined : "starting"),
});
registerMetrics(service, gateway);
registerRoutes(service, gateway);

await gateway.init();
ready = true;

const timers = [
  setInterval(() => {
    void gateway.probeAll().catch((error: unknown) => {
      logger.warn({ err: error }, "path probe failed");
    });
  }, config.PROBE_INTERVAL_SECONDS * 1000),
  setInterval(() => {
    void gateway.peers.poll().catch((error: unknown) => {
      logger.warn({ err: error }, "peer poll failed");
    });
  }, config.PEERS_INTERVAL_SECONDS * 1000),
  // Profiles are normally applied through POST /reload; this catches edits made on disk.
  setInterval(() => {
    void gateway.reload().catch((error: unknown) => {
      logger.warn({ err: error }, "reload failed");
    });
  }, 60_000),
];

if (config.GEOIP_DOWNLOAD) {
  const refreshGeo = (): void => {
    void geo.refresh(config.GEOIP_URL_TEMPLATE);
  };
  refreshGeo();
  timers.push(setInterval(refreshGeo, 24 * 60 * 60 * 1000));
} else {
  await geo.load();
}

await runService(service, config.PORT, logger, () => {
  for (const timer of timers) {
    clearInterval(timer);
  }
  return Promise.resolve();
});
logger.info({ port: config.PORT, tunnels: tunnels.list().length }, "network gateway ready");
