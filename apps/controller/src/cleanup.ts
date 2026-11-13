import { createLogger } from "@aceswarm/shared/logger";
import { loadCleanupConfig } from "./config.ts";
import { DockerClient } from "./docker.ts";
import { removeEnginesOnStackDown } from "./stack-cleanup.ts";

/**
 * The cleanup service: it waits, and when it gets SIGTERM it removes the stack's engines if the
 * whole stack is going down (see `removeEnginesOnStackDown`). The controller creates engines
 * through the Docker API, so compose doesn't know them and would otherwise leave them running.
 */

/** Compose gives this service 30 s to stop (`stop_grace_period`); it exits a little sooner. */
const CLEANUP_TIMEOUT_MS = 25_000;

const config = loadCleanupConfig();
const logger = createLogger("cleanup");
const docker = new DockerClient(config.DOCKER_HOST);

// Nothing to do until the stack stops. The timer keeps the process alive meanwhile.
const idle = setInterval(() => undefined, 2 ** 31 - 1);
const shutdown = { started: false };

const stop = (signal: string): void => {
  if (shutdown.started) {
    return;
  }
  shutdown.started = true;
  logger.info({ signal }, "shutting down");
  const timer = setTimeout(() => {
    logger.warn({ timeoutMs: CLEANUP_TIMEOUT_MS }, "removing the engines is taking too long; exiting now");
    process.exit(1);
  }, CLEANUP_TIMEOUT_MS);
  timer.unref();
  void removeEnginesOnStackDown(docker, config.STACK_NAME, logger)
    .then((result) => (result.outcome === "removed" && result.failed > 0 ? 1 : 0))
    .catch((error: unknown) => {
      logger.error({ err: error }, "could not remove the engines");
      return 1;
    })
    .then((code) => {
      clearInterval(idle);
      process.exit(code);
    });
};

process.once("SIGTERM", () => {
  stop("SIGTERM");
});
process.once("SIGINT", () => {
  stop("SIGINT");
});
logger.info({ stack: config.STACK_NAME }, "waiting to remove the engines when the stack goes down");
