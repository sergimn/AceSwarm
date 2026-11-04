import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the stack started by `e2e/run.sh` (mock engine, fake peers and a
 * throwaway WireGuard server). They share one stack, so they run in order with one worker.
 */
const channel = process.env["PW_CHANNEL"];
const executablePath = process.env["PW_CHROMIUM_PATH"];

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? `http://localhost:${process.env["E2E_HTTP_PORT"] ?? "18080"}`,
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
