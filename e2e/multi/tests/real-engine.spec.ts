import { expect, test } from "@playwright/test";
import { gatewayAssignments, resetStack, snapshot, streamById, waitForPlaying } from "../../tests/helpers.ts";
import {
  MESH,
  broadcastInfohash,
  lastAnnounce,
  newestSegment,
  remoteWireguardProfile,
  setDirectPathBlocked,
} from "./mesh.ts";

/**
 * Real Acestream engines on this runner play a real broadcast from a second runner, directly or
 * through a WireGuard server on a third runner. See e2e/README.md for the setup.
 */
test.describe.configure({ mode: "serial" });

const PROFILE = "ci-vpn";
const VPN_PATH = `wg:${PROFILE}`;
/** Filled in by the first steps; the tests share one stream. */
const run = { infohash: "", streamId: "" };

test.beforeAll(async ({ request }) => {
  setDirectPathBlocked(false);
  await resetStack(request);
  run.infohash = await broadcastInfohash();
});

test.afterAll(() => {
  setDirectPathBlocked(false);
});

test("plays a broadcast from another runner, found by its bare infohash", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add a stream" }).click();
  const dialog = page.getByRole("dialog", { name: "Add stream" });
  await dialog.getByLabel("Acestream ID or infohash").fill(run.infohash);
  await dialog.getByLabel("Name").fill("Broadcast");
  await dialog.getByRole("button", { name: "Add stream" }).click();
  await expect(dialog).toBeHidden();

  const tile = page.locator(".tile", { hasText: "Broadcast" });
  await expect(tile).toHaveAttribute("data-state", "playing", { timeout: 180_000 });

  const stream = (await snapshot(request)).streams.find((candidate) => candidate.aceId === run.infohash);
  expect(stream).toBeDefined();
  run.streamId = stream!.id;
  // A bare value is tried as a content ID first; the real engine rejects that, so it falls back.
  expect(stream!.aceIdKind).toBe("infohash");
  expect(stream!.path).toBe("direct");

  // The gateway sees the broadcast runner as a peer ("ES" in GEOIP_STATIC) on the direct path.
  await expect
    .poll(async () => (await streamById(request, run.streamId))?.peers.countries.map(({ code }) => code), {
      timeout: 60_000,
    })
    .toContain("ES");
  await expect.poll(async () => lastAnnounce(run.infohash, MESH.self), { timeout: 60_000 }).not.toBe("");

  // The transcoder turns the engine's MPEG-TS into HLS for the browser.
  const segment = await newestSegment(request, stream!.hls.full);
  expect(segment.length).toBeGreaterThan(10_000);
  expect(segment[0]).toBe(0x47);
});

test("connects to the WireGuard server another runner generated the profile on", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Network" });
  await dialog.getByLabel("Profile name").fill(PROFILE);
  await dialog.getByLabel("…or paste its contents").fill(await remoteWireguardProfile());
  await dialog.getByRole("button", { name: "Save profile" }).click();
  const section = (title: string) => dialog.locator(".section", { has: page.getByRole("heading", { name: title }) });
  await expect(section("WireGuard profiles").locator(".row", { hasText: PROFILE })).toBeVisible();
  await expect(section("Paths").locator(".row", { hasText: PROFILE })).toContainText("Up", { timeout: 90_000 });
});

test("moves the stream to the VPN when the direct path loses the broadcast", async ({ request }) => {
  const before = await waitForPlaying(request, run.streamId);
  expect(before.path).toBe("direct");
  const vpnBefore = await lastAnnounce(run.infohash, MESH.wg);

  setDirectPathBlocked(true);
  // Recovery restarts the session, then the engine, then moves the stream to a better path.
  await expect
    .poll(async () => (await streamById(request, run.streamId))?.path, { timeout: 300_000, intervals: [2000] })
    .toBe(VPN_PATH);
  const playing = await waitForPlaying(request, run.streamId, 180_000);
  expect(playing.path).toBe(VPN_PATH);
  expect(playing.recoveries).toBeGreaterThan(before.recoveries);

  // The engine's traffic now leaves through the WireGuard server's runner.
  await expect
    .poll(async () => (await lastAnnounce(run.infohash, MESH.wg)) > vpnBefore, { timeout: 60_000 })
    .toBe(true);
  expect(gatewayAssignments().map(({ path }) => path)).toContain(VPN_PATH);
});

test("stays on the VPN when the direct path works again", async ({ request }) => {
  const before = await waitForPlaying(request, run.streamId);
  setDirectPathBlocked(false);
  // Sticky path selection: a working stream never moves just because another path is fine too.
  for (let check = 0; check < 15; check += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const current = await streamById(request, run.streamId);
    expect(current?.path).toBe(VPN_PATH);
    expect(current?.state).toBe("playing");
    expect(current?.recoveries).toBe(before.recoveries);
  }
});

test("goes back to the direct path when the VPN profile is removed", async ({ request }) => {
  const directBefore = await lastAnnounce(run.infohash, MESH.self);
  const response = await request.delete(`/api/wireguard/${PROFILE}`);
  expect(response.ok(), await response.text()).toBe(true);

  await expect
    .poll(async () => (await streamById(request, run.streamId))?.path, { timeout: 180_000, intervals: [2000] })
    .toBe("direct");
  await waitForPlaying(request, run.streamId, 180_000);
  await expect
    .poll(async () => (await lastAnnounce(run.infohash, MESH.self)) > directBefore, { timeout: 60_000 })
    .toBe(true);
});
