import { expect, test } from "@playwright/test";
import {
  addStream,
  compose,
  docker,
  engineContainers,
  gatewayAssignments,
  mockId,
  snapshot,
  resetStack,
  streamById,
  tryGatewayAssignments,
  waitForPlaying,
  wireguardClientProfile,
} from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await resetStack(request);
});

test("recovers a stream whose swarm stalls", async ({ request }) => {
  // "0bad" streams stop delivering data after a while, like a swarm that dries up.
  const stream = await addStream(request, mockId("0bad", "content-id", 21), "Flaky");
  await waitForPlaying(request, stream.id);
  await expect
    .poll(async () => (await streamById(request, stream.id))?.recoveries, { timeout: 120_000, intervals: [1000] })
    .toBeGreaterThan(0);
  await waitForPlaying(request, stream.id, 120_000);
});

test("restarting one engine leaves the other streams alone", async ({ request }) => {
  const victim = await addStream(request, mockId("d1", "content-id", 22), "Victim");
  const bystander = await addStream(request, mockId("d2", "infohash", 23), "Bystander");
  await waitForPlaying(request, victim.id);
  const before = await waitForPlaying(request, bystander.id);

  const [engine] = engineContainers(victim.id);
  expect(engine).toBeDefined();
  docker("restart", "--time", "1", engine!);

  // The bystander keeps receiving new frames while the victim recovers.
  for (let check = 0; check < 10; check += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await streamById(request, bystander.id);
    expect(current?.state).toBe("playing");
    expect(current?.recoveries).toBe(before.recoveries);
  }
  await waitForPlaying(request, victim.id, 120_000);
  const after = await streamById(request, bystander.id);
  expect(Date.parse(after!.lastFrameAt!)).toBeGreaterThan(Date.parse(before.lastFrameAt!));
});

test("moves a stream to a WireGuard path when only the VPN can reach its peers", async ({ page, request }) => {
  // Upload the throwaway server's client profile through the UI, as a user would.
  await page.goto("/");
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Network" });
  await dialog.getByLabel("Profile name").fill("e2e-vpn");
  await dialog.getByLabel("…or paste its contents").fill(wireguardClientProfile());
  await dialog.getByRole("button", { name: "Save profile" }).click();
  const section = (title: string) => dialog.locator(".section", { has: page.getByRole("heading", { name: title }) });
  await expect(section("WireGuard profiles").locator(".row", { hasText: "e2e-vpn" })).toBeVisible();
  await expect(section("Paths").locator(".row", { hasText: "e2e-vpn" })).toContainText("Up", { timeout: 60_000 });

  // "beef" streams only play while the VPN-only peer answers.
  const stream = await addStream(request, mockId("beef", "content-id", 24), "VPN only");
  await expect
    .poll(async () => (await streamById(request, stream.id))?.path, { timeout: 180_000, intervals: [2000] })
    .toBe("wg:e2e-vpn");
  const playing = await waitForPlaying(request, stream.id, 120_000);
  expect(playing.path).toBe("wg:e2e-vpn");
  expect(playing.peers.countries.map((country) => country.code)).toContain("SE");
});

test("blocks engines while the gateway has no path for them, then restores their VPN path", async ({ request }) => {
  const stream = (await snapshot(request)).streams.find(
    (candidate) => candidate.aceId === mockId("beef", "content-id", 24),
  );
  expect(stream?.path).toBe("wg:e2e-vpn");
  const [engine] = engineContainers(stream!.id);
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

  // The controller sends every engine's path again, so the stream goes back to its VPN.
  await expect
    .poll(() => tryGatewayAssignments()?.find((assignment) => assignment.ip === ip)?.path, { timeout: 60_000 })
    .toBe("wg:e2e-vpn");
  const playing = await waitForPlaying(request, stream!.id, 120_000);
  expect(playing.path).toBe("wg:e2e-vpn");
});

test("rejects WireGuard profiles with hooks", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Network" });
  const profile = wireguardClientProfile().replace("[Interface]", "[Interface]\nPostUp = touch /tmp/pwned");
  await dialog.getByLabel("Profile name").fill("hooked");
  await dialog.getByLabel("…or paste its contents").fill(profile);
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(dialog.getByRole("alert")).toContainText("hooks are not supported");
});
