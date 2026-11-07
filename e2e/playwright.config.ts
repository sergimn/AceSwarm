import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the stack started by `e2e/stack.sh`: real Acestream engines playing
 * real broadcasts from another runner, directly or through a WireGuard server on a third runner.
 * See e2e/README.md. The specs share one stack, so they run in order with one worker.
 */
const channel = process.env["PW_CHANNEL"];
const executablePath = process.env["PW_CHROMIUM_PATH"];

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  // Real engines buffer, and recovering a stream climbs a ladder of restarts before a path move.
  timeout: 480_000,
  // In CI the whole run stops at 30 minutes (it usually takes about 14), before the workflow
  // step's own limit, so the report of a stuck run is still written and uploaded.
  globalTimeout: process.env["CI"] === undefined ? 0 : 1_800_000,
  expect: { timeout: 60_000 },
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    // The stack only publishes its UI on the loopback address (compose.e2e.yaml).
    baseURL: process.env["E2E_BASE_URL"] ?? `http://127.0.0.1:${process.env["E2E_HTTP_PORT"] ?? "18080"}`,
    trace: "retain-on-failure",
    // Recording needs Playwright's ffmpeg build, which CI installs.
    video: process.env["CI"] === undefined ? "off" : "retain-on-failure",
  },
  projects: [
    {
      // A TV-sized screen. Set PW_CHANNEL=chrome to test video playback with Google Chrome (H.264).
      name: "tv",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        ...(channel !== undefined && { channel }),
        // Lets a machine with a preinstalled Chromium use it instead of a downloaded one.
        ...(executablePath !== undefined && { launchOptions: { executablePath } }),
      },
    },
  ],
});
