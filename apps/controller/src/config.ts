import { envInt, parseEnv } from "@aceswarm/shared/env";
import { z } from "zod";

/**
 * What an engine uses besides its memory cache, as the dashboards count it: 147 to 162 MB in
 * testing, rounded up so that an engine at the minimum limit stays clear of the memory alert.
 */
export const ENGINE_MEMORY_OVERHEAD_MB = 200;
/** Share of its limit, in percent, above which an engine sets off the AceSwarmEngineMemoryHigh alert. */
const ENGINE_MEMORY_ALERT_PERCENT = 85;
/** Room an engine needs besides its memory cache, whatever the alert says. */
const ENGINE_MEMORY_MIN_ROOM_MB = 256;

/**
 * The smallest memory limit that suits an engine with this memory cache: 256 MB of room besides
 * the cache, and enough that an engine with a full cache stays under the memory alert.
 */
export function minEngineMemoryMb(cacheMb: number): number {
  return Math.max(
    cacheMb + ENGINE_MEMORY_MIN_ROOM_MB,
    Math.ceil(((cacheMb + ENGINE_MEMORY_OVERHEAD_MB) * 100) / ENGINE_MEMORY_ALERT_PERCENT),
  );
}

/** The largest memory cache that suits this memory limit (the inverse of minEngineMemoryMb). */
export function maxEngineMemoryCacheMb(limitMb: number): number {
  return Math.min(
    limitMb - ENGINE_MEMORY_MIN_ROOM_MB,
    Math.floor((limitMb * ENGINE_MEMORY_ALERT_PERCENT) / 100) - ENGINE_MEMORY_OVERHEAD_MB,
  );
}

const schema = z
  .object({
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
    /** Memory limit of each engine container; 0 sets none. */
    ENGINE_MEMORY_MB: envInt(512),
    /**
     * How much stream data an engine keeps in memory (the engine's `--memory-cache-limit`). Without a
     * cap an engine grows for over an hour, to about 1.7 GB in testing. 0 leaves it to the engine.
     */
    ENGINE_MEMORY_CACHE_MB: z.coerce.number().int().min(0).max(65_536).default(128),
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
     * How many streams at once may keep the new engine of a failed move, to try again on it rather
     * than on a new one that starts from no peers. Each is an engine more; 0 turns this off.
     */
    MAX_KEPT_ENGINES: envInt(2),
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
  })
  .superRefine((config, ctx) => {
    // An engine whose full cache doesn't fit under its limit is killed over and over, or sets off
    // the memory alert for good.
    const cacheMb = config.ENGINE_MEMORY_CACHE_MB;
    const limitMb = config.ENGINE_MEMORY_MB;
    const minMb = minEngineMemoryMb(cacheMb);
    if (cacheMb === 0 || limitMb === 0 || limitMb >= minMb) {
      return;
    }
    // Leaving the cache to the engine is no way out: uncapped, an engine outgrows any small limit.
    const maxCacheMb = maxEngineMemoryCacheMb(limitMb);
    ctx.addIssue({
      code: "custom",
      path: ["ENGINE_MEMORY_MB"],
      message:
        `ENGINE_MEMORY_MB=${String(limitMb)} is too small for ENGINE_MEMORY_CACHE_MB=${String(cacheMb)}. An ` +
        `engine needs at least ${String(ENGINE_MEMORY_MIN_ROOM_MB)} MB besides its cache, and with a full cache ` +
        `it uses up to ${String(ENGINE_MEMORY_OVERHEAD_MB)} MB more than the cache, which has to stay under the ` +
        `memory alert at ${String(ENGINE_MEMORY_ALERT_PERCENT)}% of the limit. Raise ENGINE_MEMORY_MB to at ` +
        `least ${String(minMb)}` +
        (maxCacheMb >= 1 ? `, or lower ENGINE_MEMORY_CACHE_MB to at most ${String(maxCacheMb)}` : ""),
    });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseEnv(schema, env);
}
