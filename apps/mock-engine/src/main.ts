import { createLogger } from "@aceswarm/shared/logger";
import { createService, runService } from "@aceswarm/shared/service";
import { loadConfig } from "./config.ts";
import { parsePeer, PeerPinger, startPeerEcho, type PeerAddress } from "./peers.ts";
import { registerRoutes } from "./server.ts";
import { SessionStore } from "./sessions.ts";

const config = loadConfig();
const logger = createLogger(config.MOCK_MODE === "peer" ? "mock-peer" : "mock-engine");

if (config.MOCK_MODE === "peer") {
  const socket = startPeerEcho(config.MOCK_PEER_PORT, config.MOCK_PEER_REPLY_BYTES, logger);
  const stop = (): void => {
    socket.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} else {
  const parse = (values: string[]): PeerAddress[] =>
    values.map((value) => parsePeer(value)).filter((peer): peer is PeerAddress => peer !== undefined);
  const peers = parse(config.MOCK_PEERS);
  const pinger = new PeerPinger(peers, parse(config.MOCK_VPN_PEERS));
  pinger.start();
  const sessions = new SessionStore();
  const service = createService({ name: "mock-engine", logger });
  registerRoutes(service, sessions, pinger, {
    ffmpegPath: config.FFMPEG_PATH,
    videoSize: config.MOCK_VIDEO_SIZE,
    fps: config.MOCK_FPS,
    loadDelayMs: config.MOCK_LOAD_DELAY_MS,
    stallAfterMs: config.MOCK_STALL_AFTER_SECONDS * 1000,
    peerWaitMs: 10_000,
  });
  await runService(service, config.PORT, logger, () => {
    sessions.stopAll();
    pinger.stop();
    return Promise.resolve();
  });
  logger.info({ port: config.PORT, peers: peers.length }, "mock engine ready");
}
