import { defineConfig } from "@playwright/test";
import base from "../playwright.config.ts";

/**
 * Multi-machine end-to-end tests: the stack from `e2e/multi/stack.sh` with real Acestream engines,
 * a broadcast on another runner and a WireGuard server on a third. See e2e/README.md.
 */
export default defineConfig({
  ...base,
  testDir: "./tests",
  // The stack only publishes its UI on the loopback address (compose.multi.yaml).
  use: {
    ...base.use,
    baseURL: process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${process.env["E2E_HTTP_PORT"] ?? "18080"}`,
  },
  // Real engines buffer, and recovering a stream climbs a ladder of restarts before a path move.
  timeout: 480_000,
});
