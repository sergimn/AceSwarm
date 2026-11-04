import { fastify, LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { collectDefaultMetrics, Registry } from "@prometheus-io/client";
import { inSubnet } from "./ipv4.ts";
import type { Logger } from "./logger.ts";

export interface ServiceOptions {
  name: string;
  logger: Logger;
  /** Extra readiness check used by `/healthz`; return a message to report as unhealthy. */
  health?: () => string | undefined;
  bodyLimit?: number;
  /**
   * Networks whose clients get 403 for every request. Engines run third-party P2P software, so
   * services that share the engines network refuse it (an engine could otherwise ask the gateway
   * to move it off its VPN).
   */
  blockedClients?: readonly string[];
}

export interface Service {
  app: FastifyInstance;
  registry: Registry;
}

/**
 * Builds a Fastify instance with the endpoints every service exposes: `/healthz` for Docker
 * health checks and `/metrics` for Alloy to scrape.
 */
export function createService(options: ServiceOptions): Service {
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.name });
  collectDefaultMetrics({ register: registry });

  const loggerInstance: FastifyBaseLogger = options.logger;
  const app = fastify({
    loggerInstance,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: options.bodyLimit ?? 1_048_576,
  });

  const blocked = options.blockedClients ?? [];
  if (blocked.length > 0) {
    app.addHook("onRequest", async (request, reply) => {
      if (isBlockedClient(request.socket.remoteAddress, blocked)) {
        await reply.code(403).send({ error: "forbidden" });
      }
    });
  }

  app.get("/healthz", async (_request, reply) => {
    const problem = options.health?.();
    return problem === undefined ? { status: "ok" } : reply.code(503).send({ status: "unhealthy", problem });
  });

  app.get("/metrics", async (_request, reply) => {
    const body = await registry.metrics();
    return reply.header("content-type", registry.contentType).send(body);
  });

  return { app, registry };
}

/** True when the address (IPv4, or IPv4-mapped IPv6) is in one of the networks. */
export function isBlockedClient(address: string | undefined, networks: readonly string[]): boolean {
  if (address === undefined) {
    return false;
  }
  const ipv4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return networks.some((network) => inSubnet(ipv4, network));
}

/** Starts listening and wires SIGTERM/SIGINT to a graceful shutdown. */
export async function runService(
  service: Service,
  port: number,
  logger: Logger,
  onShutdown: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, "shutting down");
    void (async () => {
      try {
        await onShutdown();
        await service.app.close();
      } catch (error) {
        logger.error({ err: error }, "error during shutdown");
      } finally {
        process.exit(0);
      }
    })();
  };
  process.once("SIGTERM", () => {
    stop("SIGTERM");
  });
  process.once("SIGINT", () => {
    stop("SIGINT");
  });
  await service.app.listen({ port, host: "0.0.0.0" });
}
