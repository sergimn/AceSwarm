/**
 * The cleanup service: it waits, and when it gets SIGTERM it removes the stack's engines if the
 * whole stack is going down (see `removeEnginesOnStackDown`). The controller creates engines
 * through the Docker API, so compose doesn't know them and would otherwise leave them running.
 *
 * It listens for signals before it loads anything else. Node runs as the container's PID 1, which
 * ignores a signal it has no handler for, so a stop that came while the modules load would wait out
 * compose's grace period and remove nothing. Static imports load before this code runs, so
 * everything else comes in with `import()`, and a signal that came meanwhile is handled once it has.
 */
const early: string[] = [];
const handler: { stop?: (signal: string) => Promise<void> } = {};
const onSignal = (signal: string): void => {
  if (handler.stop === undefined) {
    early.push(signal);
  } else {
    void handler.stop(signal);
  }
};
process.on("SIGTERM", () => {
  onSignal("SIGTERM");
});
process.on("SIGINT", () => {
  onSignal("SIGINT");
});

const [{ createLogger }, { loadCleanupConfig }, { DockerClient }, { cleanupOnSignal }] = await Promise.all([
  import("@aceswarm/shared/logger"),
  import("./config.ts"),
  import("./docker.ts"),
  import("./stack-cleanup.ts"),
]);
const config = loadCleanupConfig();
const logger = createLogger("cleanup");
// Nothing to do until the stack stops. The timer keeps the process alive meanwhile.
setInterval(() => undefined, 2 ** 31 - 1);
handler.stop = cleanupOnSignal({ docker: new DockerClient(config.DOCKER_HOST), stack: config.STACK_NAME, logger });
logger.info({ stack: config.STACK_NAME }, "waiting to remove the engines when the stack goes down");
for (const signal of early) {
  void handler.stop(signal);
}
