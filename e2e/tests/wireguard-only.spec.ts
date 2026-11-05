import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  addStream,
  compose,
  engineContainers,
  gatewayAssignments,
  gatewayRequest,
  mockId,
  resetStack,
  streamById,
  waitForPlaying,
  wireguardClientProfile,
} from "./helpers.ts";

// "WireGuard only": streams never use the direct path. The controller stops choosing it, and the
// gateway refuses it on its own as well.
test.describe.configure({ mode: "serial" });

const PROFILE = "e2e-vpn";
const VPN_PATH = `wg:${PROFILE}`;
/** Filled in by the steps; they share the streams. */
const run = { movedId: "", vpnOnlyId: "", waitingId: "" };

test.beforeAll(async ({ request }) => {
  await resetStack(request);
});

test.afterAll(async ({ request }) => {
  setVpnServerDown(false);
  await request.patch("/api/network", { data: { wireguardOnly: false } });
});

/**
 * Makes the throwaway WireGuard server drop every WireGuard packet, like a VPN provider that went
 * away. Pausing its container is not enough: kernel WireGuard keeps answering from a frozen one.
 */
function setVpnServerDown(down: boolean): void {
  const rule = ["INPUT", "-p", "udp", "--dport", "51820", "-j", "DROP"];
  const present = (): boolean => {
    try {
      compose("exec", "-T", "wg-server", "iptables", "-C", ...rule);
      return true;
    } catch {
      return false;
    }
  };
  if (down && !present()) {
    compose("exec", "-T", "wg-server", "iptables", "-I", ...rule);
  }
  while (!down && present()) {
    compose("exec", "-T", "wg-server", "iptables", "-D", ...rule);
  }
}

async function openNetwork(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Network" });
  const section = (title: string) => dialog.locator(".section", { has: page.getByRole("heading", { name: title }) });
  return { dialog, section, toggle: dialog.getByRole("switch", { name: "WireGuard only" }) };
}

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
  const stream = await addStream(request, mockId("e2", "content-id", 41), "Leaves direct");
  const before = await waitForPlaying(request, stream.id);
  expect(before.path).toBe("direct");
  run.movedId = stream.id;

  const { dialog, section, toggle } = await openNetwork(page);
  await dialog.getByLabel("Profile name").fill(PROFILE);
  await dialog.getByLabel("…or paste its contents").fill(wireguardClientProfile());
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(section("Paths").locator(".row", { hasText: PROFILE })).toContainText("Up", { timeout: 60_000 });
  await expect(toggle).toHaveAttribute("aria-disabled", "false");

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

  // It moves without waiting to stall first, and the move is not counted as a recovery.
  await expect
    .poll(async () => (await streamById(request, stream.id))?.path, { timeout: 90_000, intervals: [1000] })
    .toBe(VPN_PATH);
  const playing = await waitForPlaying(request, stream.id);
  expect(playing.path).toBe(VPN_PATH);
  expect(playing.recoveries).toBe(before.recoveries);
  expect(engineContainers(stream.id)).toHaveLength(1);
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
  // "beef" streams only play while the VPN-only peer answers, so this one stalls when the VPN goes.
  const vpnOnly = await addStream(request, mockId("beef", "content-id", 43), "Needs the VPN");
  run.vpnOnlyId = vpnOnly.id;
  expect((await waitForPlaying(request, vpnOnly.id, 120_000)).path).toBe(VPN_PATH);

  // Silence the VPN: its probes fail and the path goes down.
  setVpnServerDown(true);
  const { section } = await openNetwork(page);
  await expect(section("Paths").locator(".row", { hasText: PROFILE })).toContainText("Down", { timeout: 60_000 });

  // The stream stalls and tries to recover where it is, then waits for a WireGuard path. With
  // WireGuard only off, its first recovery would move it to the direct path, which is up and
  // scores better. Watch long enough for the stall, that recovery and a few more ladder steps.
  const deadline = Date.now() + 40_000;
  let recoveries = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await streamById(request, vpnOnly.id);
    expect(current?.path).toBe(VPN_PATH);
    expect(gatewayAssignments().map(({ path }) => path)).not.toContain("direct");
    recoveries = current?.recoveries ?? 0;
  }
  expect(recoveries).toBeGreaterThanOrEqual(1);

  const waiting = await addStream(request, mockId("e3", "infohash", 42), "Waits for VPN");
  run.waitingId = waiting.id;
  await expect
    .poll(async () => (await streamById(request, waiting.id))?.message ?? "", { timeout: 30_000 })
    .toContain("no WireGuard path is up");
  // No engine is started while there is nowhere to send it.
  expect(engineContainers(waiting.id)).toHaveLength(0);

  expect((await streamById(request, run.movedId))?.path).toBe(VPN_PATH);

  setVpnServerDown(false);
  await expect(section("Paths").locator(".row", { hasText: PROFILE })).toContainText("Up", { timeout: 60_000 });
  const started = await waitForPlaying(request, waiting.id, 120_000);
  expect(started.path).toBe(VPN_PATH);
  for (const id of [run.movedId, run.vpnOnlyId]) {
    expect((await waitForPlaying(request, id, 120_000)).path).toBe(VPN_PATH);
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
