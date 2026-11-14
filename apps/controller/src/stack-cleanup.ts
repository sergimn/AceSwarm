import type { Logger } from "@aceswarm/shared/logger";
import type { ContainerSummary, DockerClient } from "./docker.ts";
import { ROLE_LABEL, STACK_LABEL } from "./engines.ts";

/**
 * The label compose.yaml gives the controller's container, with the stack's name as its value. The
 * cleanup service looks for it: while a controller runs, the stack isn't going down.
 */
export const CONTROLLER_LABEL = "aceswarm.controller";

/**
 * States in which a controller may still use its engines, or soon will again. Podman reports
 * "stopping" while a container stops; Docker says "running" until it exited.
 */
const ALIVE_STATES = new Set(["running", "restarting", "paused", "stopping"]);

export type CleanupResult =
  { outcome: "kept"; controllers: string[] } | { outcome: "removed"; removed: number; failed: number };

/**
 * What the cleanup service does when it gets SIGTERM: it removes every engine of the stack (the
 * streams' own engines, shared engines and hot standbys), unless a controller still runs.
 *
 * The controller can't do this itself, because a controller restart (an update, say) also sends it
 * SIGTERM, and the restarted controller takes over the engines that kept playing. Compose tells the
 * two apart for us: the controller depends on the cleanup service, so `docker compose down` and
 * `docker compose stop` stop the controller, wait until it exited, and only then stop this
 * service. When this service stops while a controller runs, only this service is going away, as
 * when `docker compose up -d` recreates it after an update (dependencies first, so before the
 * controller). The engines then stay for the controller.
 */
export async function removeEnginesOnStackDown(
  docker: DockerClient,
  stack: string,
  logger: Logger,
): Promise<CleanupResult> {
  const containers = await docker.listContainers({ [CONTROLLER_LABEL]: stack });
  const controllers = containers
    .filter((container) => ALIVE_STATES.has(container.State))
    .map((container) => containerName(container));
  if (controllers.length > 0) {
    logger.info({ controllers }, "a controller still runs, so the stack isn't going down: leaving the engines");
    return { outcome: "kept", controllers };
  }
  const engines = await docker.listContainers({ [STACK_LABEL]: stack, [ROLE_LABEL]: "engine" });
  const results = await Promise.all(
    engines.map(async (engine) => {
      try {
        await docker.removeContainer(engine.Id);
        return true;
      } catch (error) {
        logger.warn({ container: containerName(engine), err: error }, "could not remove an engine");
        return false;
      }
    }),
  );
  const failed = results.filter((ok) => !ok).length;
  const removed = engines.length - failed;
  logger.info({ removed, failed }, "the stack is going down: removed its engines");
  return { outcome: "removed", removed, failed };
}

function containerName(container: ContainerSummary): string {
  return container.Names[0]?.replace(/^\//, "") ?? container.Id;
}

/** Compose gives the cleanup service 30 s to stop (`stop_grace_period`); it exits a little sooner. */
export const CLEANUP_TIMEOUT_MS = 25_000;

export interface CleanupOnSignalOptions {
  docker: DockerClient;
  stack: string;
  logger: Logger;
  timeoutMs?: number;
  /** Ends the process (tests pass their own). */
  exit?: (code: number) => void;
}

/**
 * The cleanup service's signal handler: the first SIGTERM or SIGINT runs `removeEnginesOnStackDown`,
 * then exits: with 1 if an engine couldn't be removed or Docker couldn't be reached, and with 1
 * after `timeoutMs` if that takes too long. Later signals change nothing.
 */
export function cleanupOnSignal(options: CleanupOnSignalOptions): (signal: string) => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? CLEANUP_TIMEOUT_MS;
  const state = { started: false, exited: false };
  const exitOnce = (code: number): void => {
    if (state.exited) {
      return;
    }
    state.exited = true;
    exit(code);
  };
  return async (signal) => {
    if (state.started) {
      return;
    }
    state.started = true;
    options.logger.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      options.logger.warn({ timeoutMs }, "removing the engines is taking too long; exiting now");
      exitOnce(1);
    }, timeoutMs);
    timer.unref();
    const code = await removeEnginesOnStackDown(options.docker, options.stack, options.logger)
      .then((result) => (result.outcome === "removed" && result.failed > 0 ? 1 : 0))
      .catch((error: unknown) => {
        options.logger.error({ err: error }, "could not remove the engines");
        return 1;
      });
    clearTimeout(timer);
    exitOnce(code);
  };
}
