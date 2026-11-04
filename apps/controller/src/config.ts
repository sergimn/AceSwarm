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
  ENGINE_HTTP_PORT: envInt(6878),
  ENGINE_MEMORY_MB: envInt(2048),
  /** How often engine memory is sampled for the metrics. */
  ENGINE_STATS_SECONDS: envInt(15),
  ENGINE_EXTRA_FLAGS: z.string().default(""),
  /** DNS servers for engines, reached through the gateway like the rest of their traffic. */
  ENGINE_DNS: z.string().default("1.1.1.1,9.9.9.9"),
  ENGINE_READY_TIMEOUT_SECONDS: envInt(90),
  TRANSCODER_URL: z.string().default("http://transcoder:8081"),
  NETGW_URL: z.string().default("http://netgw:8082"),
  PATH_STRATEGY: z.enum(["sticky-best", "round-robin"]).default("sticky-best"),
  /** Minimum score advantage a new path needs over the current one before a stream moves. */
  PATH_HYSTERESIS: z.coerce.number().min(0).max(1).default(0.15),
  /** After a path switch, wait this long before another switch unless the path goes down. */
  PATH_MIN_DWELL_SECONDS: envInt(300),
  TICK_MS: envInt(2000),
  STALL_SECONDS: envInt(20),
  STARTUP_GRACE_SECONDS: envInt(90),
  RECOVERY_BASE_DELAY_SECONDS: envInt(5),
  RECOVERY_MAX_DELAY_SECONDS: envInt(300),
  HANDOVER_TIMEOUT_SECONDS: envInt(120),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseEnv(schema, env);
}
