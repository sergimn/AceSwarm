import { expect, test } from "@playwright/test";
import {
  addProfileFromUi,
  addStream,
  compose,
  docker,
  engineContainers,
  gatewayAssignments,
  openNetwork,
  resetStack,
  streamById,
  tryGatewayAssignments,
  waitForPlaying,
} from "./helpers.ts";
import { MESH, broadcasts, lastAnnounce, newestSegment, remoteWireguardProfile, setDirectPathBlocked } from "./mesh.ts";

/**
 * Network paths: real engines on this runner play a broadcast from a second runner, directly or
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
  run.infohash = (await broadcasts(1))[0]!.infohash;
});

test.afterAll(() => {
  setDirectPathBlocked(false);
});

test("plays a broadcast from another runner on the direct path", async ({ request }) => {
  const stream = await addStream(request, run.infohash, "Broadcast");
  run.streamId = stream.id;
  const playing = await waitForPlaying(request, stream.id);
  expect(playing.path).toBe("direct");

  // The gateway sees the broadcast runner as a peer ("ES" in GEOIP_STATIC) on the direct path, and
  // the engine announced from this runner's own mesh address.
  await expect
    .poll(async () => (await streamById(request, run.streamId))?.peers.countries.map(({ code }) => code), {
      timeout: 60_000,
    })
    .toContain("ES");
  await expect.poll(async () => lastAnnounce(run.infohash, MESH.self), { timeout: 60_000 }).not.toBe("");

  // The transcoder turns the engine's MPEG-TS into HLS for the browser.
  const segment = await newestSegment(request, playing.hls.full);
  expect(segment.length).toBeGreaterThan(10_000);
  expect(segment[0]).toBe(0x47);
});

test("rejects WireGuard profiles with hooks", async ({ page }) => {
  const { dialog } = await openNetwork(page);
  const profile = (await remoteWireguardProfile()).replace("[Interface]", "[Interface]\nPostUp = touch /tmp/pwned");
  await dialog.getByLabel("Profile name").fill("hooked");
  await dialog.getByLabel("…or paste its contents").fill(profile);
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(dialog.getByRole("alert")).toContainText("hooks are not supported");
});

test("connects to the WireGuard server another runner generated the profile on", async ({ page }) => {
  await addProfileFromUi(page, PROFILE, await remoteWireguardProfile());
});

test("moves the stream to the VPN when the direct path loses the broadcast", async ({ request }) => {
  const before = await waitForPlaying(request, run.streamId);
  expect(before.path).toBe("direct");
  const vpnBefore = await lastAnnounce(run.infohash, MESH.wg);

  setDirectPathBlocked(true);
  // Recovery restarts the session, then the engine, then moves the stream to another path.
  await expect
    .poll(async () => (await streamById(request, run.streamId))?.path, { timeout: 300_000, intervals: [2000] })
    .toBe(VPN_PATH);
  const playing = await waitForPlaying(request, run.streamId);
  expect(playing.path).toBe(VPN_PATH);
  expect(playing.recoveries).toBeGreaterThan(before.recoveries);
  // The swarm is still the broadcast runner, now reached through the tunnel.
  await expect
    .poll(async () => (await streamById(request, run.streamId))?.peers.countries.map(({ code }) => code), {
      timeout: 60_000,
    })
    .toContain("ES");

  // The engine's traffic now leaves through the WireGuard server's runner.
  await expect
    .poll(async () => (await lastAnnounce(run.infohash, MESH.wg)) > vpnBefore, { timeout: 60_000 })
    .toBe(true);
  expect(gatewayAssignments().map(({ path }) => path)).toContain(VPN_PATH);
});

test("blocks engines while the gateway has no path for them, then restores their VPN path", async ({ request }) => {
  // The move started a new engine on the VPN before removing the old one.
  await expect.poll(() => engineContainers(run.streamId).length, { timeout: 30_000 }).toBe(1);
  const [engine] = engineContainers(run.streamId);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", engine!).trim();

  // Freeze the controller, so it can't send the paths again, to see what the gateway does alone.
  compose("pause", "controller");
  try {
    compose("restart", "netgw");
    await expect.poll(() => tryGatewayAssignments(), { timeout: 60_000 }).toBeDefined();
    expect(gatewayAssignments().map((assignment) => assignment.ip)).not.toContain(ip);
    const rules = compose("exec", "-T", "netgw", "iptables", "-S");
    expect(rules).toContain("-P FORWARD DROP");
    // No accept rule for the engine: it can't reach anything, not even through the direct path.
    expect(rules).not.toContain(`-s ${ip}/32`);
  } finally {
    compose("unpause", "controller");
  }

  // The controller sends every engine's path again, so the stream goes back to its VPN. The
  // direct path still can't reach the broadcast, so the VPN is the only place it can play.
  await expect
    .poll(() => tryGatewayAssignments()?.find((assignment) => assignment.ip === ip)?.path, { timeout: 60_000 })
    .toBe(VPN_PATH);
  const playing = await waitForPlaying(request, run.streamId);
  expect(playing.path).toBe(VPN_PATH);
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
  await waitForPlaying(request, run.streamId);
  await expect
    .poll(async () => (await lastAnnounce(run.infohash, MESH.self)) > directBefore, { timeout: 60_000 })
    .toBe(true);
});
