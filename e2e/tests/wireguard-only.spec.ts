import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  addStream,
  compose,
  engineContainers,
  gatewayAssignments,
  gatewayRequest,
  openNetwork,
  resetStack,
  streamById,
  waitForPlaying,
} from "./helpers.ts";
import {
  MESH,
  broadcasts,
  lastAnnounce,
  remoteWireguardProfile,
  setVpnServerUnreachable,
  type Broadcast,
} from "./mesh.ts";

// "WireGuard only": streams never use the direct path. The controller stops choosing it, and the
// gateway refuses it on its own as well.
test.describe.configure({ mode: "serial" });

const PROFILE = "e2e-vpn";
const VPN_PATH = `wg:${PROFILE}`;
/** Filled in by the steps; they share the streams. */
const run = { movedId: "", vpnOnlyId: "", waitingId: "" };

const bc: Broadcast[] = [];

test.beforeAll(async ({ request }) => {
  setVpnServerUnreachable(false);
  await resetStack(request);
  bc.push(...(await broadcasts(3)));
});

test.afterAll(async ({ request }) => {
  setVpnServerUnreachable(false);
  await request.patch("/api/network", { data: { wireguardOnly: false } });
});

/** The interface of the gateway's direct path. */
function gatewayEgressInterface(): string {
  const routes = JSON.parse(compose("exec", "-T", "netgw", "ip", "-j", "-4", "route", "show", "default")) as {
    dev: string;
  }[];
  const dev = routes[0]?.dev;
  expect(dev).toBeDefined();
  return dev!;
}

async function wireguardOnly(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/network");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { wireguardOnly: boolean }).wireguardOnly;
}

test("is greyed out until a WireGuard profile exists", async ({ page, request }) => {
  const { dialog, toggle } = await openNetwork(page);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(dialog).toContainText("Add a WireGuard profile first.");

  // It still takes focus, so a TV remote can reach it and see why it is unavailable: Down from
  // the dialog's close button, where focus starts.
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".toast.error")).toContainText("Add a WireGuard profile first.");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // The API refuses it too.
  const response = await request.patch("/api/network", { data: { wireguardOnly: true } });
  expect(response.status()).toBe(409);
  expect(await wireguardOnly(request)).toBe(false);
});

test("moves a playing stream off the direct path as soon as it is turned on", async ({ page, request }) => {
  const { infohash } = bc[0]!;
  const stream = await addStream(request, infohash, "Leaves direct");
  const before = await waitForPlaying(request, stream.id);
  expect(before.path).toBe("direct");
  run.movedId = stream.id;

  const { dialog, section, toggle } = await openNetwork(page);
  await dialog.getByLabel("Profile name").fill(PROFILE);
  await dialog.getByLabel("…or paste its contents").fill(await remoteWireguardProfile());
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(section("Paths").locator(".row", { hasText: PROFILE })).toContainText("Up", { timeout: 90_000 });
  await expect(toggle).toHaveAttribute("aria-disabled", "false");
  const vpnBefore = await lastAnnounce(infohash, MESH.wg);

  // Remote navigation: Up from the profile's button and Down from the close button both reach it.
  // With the dialog scrolled down, Up must not jump to the sticky header's close button, and the
  // switch it scrolls back to must not stay hidden under that header.
  await page.evaluate(`document.querySelector("dialog[open]").scrollTop = 1e6`);
  await section("WireGuard profiles").getByRole("button", { name: "Remove" }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(toggle).toBeFocused();
  const header = await dialog.locator(".dialog-header").boundingBox();
  const switchBox = await toggle.boundingBox();
  expect(switchBox!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  await dialog.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(section("Paths").locator(".row", { hasText: "Direct" })).toContainText("Off");
  expect(await wireguardOnly(request)).toBe(true);

  // The gateway cuts the engine off the direct path at once, and the stream moves without first
  // waiting to stall. The move is not counted as a recovery.
  await expect
    .poll(async () => (await streamById(request, stream.id))?.path, { timeout: 240_000, intervals: [1000] })
    .toBe(VPN_PATH);
  const playing = await waitForPlaying(request, stream.id);
  expect(playing.path).toBe(VPN_PATH);
  expect(playing.recoveries).toBe(before.recoveries);
  await expect.poll(() => engineContainers(stream.id).length, { timeout: 30_000 }).toBe(1);
  // Its traffic now leaves through the WireGuard server's runner.
  await expect.poll(async () => (await lastAnnounce(infohash, MESH.wg)) > vpnBefore, { timeout: 60_000 }).toBe(true);
});

test("the gateway keeps engines off the direct path on its own", () => {
  const policy = JSON.parse(gatewayRequest("GET", "/policy").body) as { wireguardOnly: boolean };
  expect(policy.wireguardOnly).toBe(true);
  expect(gatewayAssignments().map(({ path }) => path)).not.toContain("direct");

  // Even if something asked it to, it would refuse to send an engine out the direct path.
  const refused = gatewayRequest("PUT", "/assignments/172.31.250.250", { path: "direct" });
  expect(refused.status).toBe(409);

  // No engine may forward out of the direct interface, and nothing is translated for it.
  const egress = gatewayEgressInterface();
  const forward = compose("exec", "-T", "netgw", "iptables", "-S", "ACESWARM-FWD");
  expect(forward).not.toContain(`-o ${egress} -j ACCEPT`);
  const nat = compose("exec", "-T", "netgw", "iptables", "-t", "nat", "-S", "ACESWARM-NAT");
  expect(nat).not.toContain(`-o ${egress} `);
});

test("streams wait instead of going direct while no WireGuard path is up", async ({ page, request }) => {
  const vpnOnly = await addStream(request, bc[1]!.contentId, "Needs the VPN");
  run.vpnOnlyId = vpnOnly.id;
  const before = await waitForPlaying(request, vpnOnly.id);
  expect(before.path).toBe(VPN_PATH);

  // Make the WireGuard server unreachable: the tunnel stops carrying anything, its probes fail and
  // the path goes down, while the direct path stays up.
  setVpnServerUnreachable(true);
  try {
    const { section } = await openNetwork(page);
    await expect(section("Paths").locator(".row", { hasText: PROFILE })).toContainText("Down", { timeout: 60_000 });

    // The stream stalls once the engine's buffer runs out, and tries to recover where it is. With
    // WireGuard only off, its first recovery would move it to the direct path, which is up and
    // scores better. Watch for the stall, that recovery and a few more ladder steps.
    const watchStart = Date.now();
    let recoveries = before.recoveries;
    while (Date.now() - watchStart < 30_000 || (recoveries <= before.recoveries && Date.now() - watchStart < 150_000)) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const current = await streamById(request, vpnOnly.id);
      expect(current?.path).toBe(VPN_PATH);
      expect(gatewayAssignments().map(({ path }) => path)).not.toContain("direct");
      recoveries = current?.recoveries ?? 0;
    }
    expect(recoveries).toBeGreaterThan(before.recoveries);

    const waiting = await addStream(request, bc[2]!.infohash, "Waits for VPN");
    run.waitingId = waiting.id;
    await expect
      .poll(async () => (await streamById(request, waiting.id))?.message ?? "", { timeout: 30_000 })
      .toContain("no WireGuard path is up");
    // No engine is started while there is nowhere to send it.
    expect(engineContainers(waiting.id)).toHaveLength(0);

    expect((await streamById(request, run.movedId))?.path).toBe(VPN_PATH);
  } finally {
    setVpnServerUnreachable(false);
  }

  const { section } = await openNetwork(page);
  await expect(section("Paths").locator(".row", { hasText: PROFILE })).toContainText("Up", { timeout: 90_000 });
  const started = await waitForPlaying(request, run.waitingId);
  expect(started.path).toBe(VPN_PATH);
  for (const id of [run.movedId, run.vpnOnlyId]) {
    expect((await waitForPlaying(request, id)).path).toBe(VPN_PATH);
  }
});

test("keeps the last profile while it is on", async ({ request }) => {
  const response = await request.delete(`/api/wireguard/${PROFILE}`);
  expect(response.status()).toBe(409);
  expect(await response.text()).toContain("Turn WireGuard only off first");
  const profiles = (await (await request.get("/api/wireguard")).json()) as { name: string }[];
  expect(profiles.map(({ name }) => name)).toEqual([PROFILE]);
});

test("turning it off allows the direct path again, and streams stay where they are", async ({ page, request }) => {
  const { section, toggle } = await openNetwork(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(section("Paths").locator(".row", { hasText: "Direct" })).toContainText("Up");
  expect(JSON.parse(gatewayRequest("GET", "/policy").body)).toEqual({ wireguardOnly: false });

  // Sticky paths: a working stream never moves just because the direct path is allowed again.
  for (let check = 0; check < 5; check += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const id of [run.movedId, run.vpnOnlyId, run.waitingId]) {
      const stream = await streamById(request, id);
      expect(stream?.path).toBe(VPN_PATH);
      expect(stream?.state).toBe("playing");
    }
  }
});
