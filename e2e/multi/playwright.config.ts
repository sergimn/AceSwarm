import { defineConfig } from "@playwright/test";
import base from "../playwright.config.ts";

/**
 * Multi-machine end-to-end tests: the stack from `e2e/multi/stack.sh` with real Acestream engines,
 * a broadcast on another runner and a WireGuard server on a third. See e2e/README.md.
 */
export default defineConfig({
  ...base,
  testDir: "./tests",
  // Real engines buffer, and recovering a stream climbs a ladder of restarts before a path move.
  timeout: 480_000,
});
