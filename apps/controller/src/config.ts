import { envInt, parseEnv } from "@aceswarm/shared/env";
import { z } from "zod";

const schema = z.object({
  PORT: envInt(8080),
  DATA_DIR: z.string().default("/data"),
  UI_DIR: z.string().default(new URL("../public", import.meta.url).pathname),
  /** Docker API endpoint. Always a socket proxy, never the raw socket. */
  DOCKER_HOST: z
    .string()
    .default("tcp://docker-proxy:2375")
    .transform((value) => value.replace(/^tcp:\/\//, "http://").replace(/\/+$/, "")),
  /** Label value that marks engines owned by this stack, so several stacks can share a host. */
  STACK_NAME: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .default("aceswarm"),
  ENGINE_IMAGE: z.string().default("ghcr.io/sergimn/aceswarm-engine:latest"),
  ENGINE_NETWORK: z.string().default("aceswarm_engines"),
  /** Address of the network gateway on the engines network; engines use it as default route. */
  ENGINE_GATEWAY_IP: z.ipv4().default("172.31.250.2"),
  /**
   * Addresses Docker gives containers on the engines network (its ip_range), engines included.
   * Requests from them are refused: engines run untrusted P2P software. The network's gateway
   * address is outside the range, because published ports can arrive through it.
   */
  ENGINE_IP_RANGE: z.cidrv4().default("172.31.250.128/25"),
  ENGINE_HTTP_PORT: envInt(6878),
  ENGINE_MEMORY_MB: envInt(2048),
  /** How often engine memory is sampled for the metrics. */
  ENGINE_STATS_SECONDS: envInt(15),
  ENGINE_EXTRA_FLAGS: z.string().default(""),
  /** DNS servers for engines, reached through the gateway like the rest of their traffic. */
  ENGINE_DNS: z.string().default("1.1.1.1,9.9.9.9"),
  ENGINE_READY_TIMEOUT_SECONDS: envInt(90),
  /** Names that exist only on the backend network, so these calls never cross the engines network. */
  TRANSCODER_URL: z.string().default("http://transcoder-api:8081"),
  NETGW_URL: z.string().default("http://netgw-api:8082"),
  PATH_STRATEGY: z.enum(["sticky-best", "round-robin"]).default("sticky-best"),
  /** After a path switch, wait this long before another switch unless the path goes down. */
  PATH_MIN_DWELL_SECONDS: envInt(300),
  TICK_MS: envInt(2000),
  STALL_SECONDS: envInt(20),
  STARTUP_GRACE_SECONDS: envInt(90),
  RECOVERY_BASE_DELAY_SECONDS: envInt(5),
  RECOVERY_MAX_DELAY_SECONDS: envInt(300),
  HANDOVER_TIMEOUT_SECONDS: envInt(120),
  /**
   * With engine sharing on, a path's shared engine restarts once more than this many of its streams
   * failed within SHARED_ENGINE_FAILURE_WINDOW_SECONDS (or when the stream someone watches fails).
   */
  SHARED_ENGINE_MAX_FAILURES: envInt(2),
  SHARED_ENGINE_FAILURE_WINDOW_SECONDS: envInt(60),
  /**
   * How often a player showing a stream full screen reports it; it counts as gone after missing two.
   * Players report at most every 5 s.
   */
  VIEWER_PING_SECONDS: z.coerce.number().int().min(5).default(60),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseEnv(schema, env);
}
