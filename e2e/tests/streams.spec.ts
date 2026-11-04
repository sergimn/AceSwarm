import { expect, test } from "@playwright/test";
import { addStream, compose, mockId, resetStack, snapshot, streamById, waitForPlaying } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await resetStack(request);
});

test("adds a stream from the UI and shows its live stats", async ({ page, request }) => {
  const aceId = mockId("a1", "content-id", 1);
  await page.goto("/");
  await expect(page.locator("#empty")).toBeVisible();

  await page.getByRole("button", { name: "Add a stream" }).click();
  const dialog = page.getByRole("dialog", { name: "Add stream" });
  await dialog.getByLabel("Acestream ID or infohash").fill(`acestream://${aceId}`);
  await dialog.getByLabel("Name").fill("Mock sports");
  await dialog.getByRole("button", { name: "Add stream" }).click();
  await expect(dialog).toBeHidden();

  const tile = page.locator(".tile", { hasText: "Mock sports" });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("data-state", "playing", { timeout: 90_000 });

  // Stats show on hover (and on focus with a remote).
  await tile.hover();
  const stats = tile.locator(".tile-stats");
  await expect(stats).toBeVisible();
  await expect(stats.locator(".stat", { hasText: "Freshness" })).toContainText("Now");
  await expect(stats.locator(".stat", { hasText: "Peers" })).toContainText(/[12] sending · [12] connected/);
  // The fake peers are placed in Spain and France (GEOIP_STATIC in e2e/compose.e2e.yaml).
  await expect(stats.locator(".country-code")).toHaveText(["ES", "FR"]);
  await expect(stats.locator(".fi.fi-es")).toBeAttached();
  await expect(stats.locator(".stat", { hasText: "Download" })).toContainText(/KB\/s|MB\/s/);

  const id = (await snapshot(request)).streams.find((stream) => stream.aceId === aceId)?.id;
  expect(id).toBeDefined();
  expect((await streamById(request, id!))?.aceIdKind).toBe("content-id");
});

test("detects infohashes without being told", async ({ page, request }) => {
  // A bare value is tried as a content ID first; the mock rejects it, so it must fall back.
  const bare = await addStream(request, mockId("b2", "infohash", 2));
  expect(bare.aceIdKind).toBeNull();
  expect((await waitForPlaying(request, bare.id)).aceIdKind).toBe("infohash");

  // A magnet link says what it is up front.
  const magnet = await addStream(request, `magnet:?xt=urn:btih:${mockId("b3", "infohash", 3)}&dn=test`);
  expect(magnet.aceIdKind).toBe("infohash");
  await waitForPlaying(request, magnet.id);

  await page.goto("/");
  await page.getByRole("button", { name: "Streams", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Streams" });
  await expect(dialog.locator(".row", { hasText: bare.aceId })).toContainText("infohash");
  await expect(dialog.locator(".row", { hasText: mockId("a1", "content-id", 1) })).toContainText("content ID");
});

test("rejects text that is not a stream ID", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add stream" });
  await dialog.getByLabel("Acestream ID or infohash").fill("not an id");
  await dialog.getByRole("button", { name: "Add stream" }).click();
  await expect(dialog.getByRole("alert")).toContainText("does not look like");
});

test("keeps streams and their detected kind across a controller restart", async ({ request }) => {
  const before = (await snapshot(request)).streams.map(({ id, aceId, aceIdKind, name }) => ({
    id,
    aceId,
    aceIdKind,
    name,
  }));
  expect(before.length).toBeGreaterThanOrEqual(3);

  compose("restart", "controller");
  await expect
    .poll(async () => (await request.get("/healthz").catch(() => undefined))?.ok(), { timeout: 60_000 })
    .toBe(true);

  const after = (await snapshot(request)).streams.map(({ id, aceId, aceIdKind, name }) => ({
    id,
    aceId,
    aceIdKind,
    name,
  }));
  expect(after).toEqual(before);
  for (const stream of after) {
    await waitForPlaying(request, stream.id);
  }
});

test("removes a stream from the manage dialog", async ({ page, request }) => {
  const target = (await snapshot(request)).streams.find((stream) => stream.aceId === mockId("b3", "infohash", 3));
  expect(target).toBeDefined();

  await page.goto("/");
  await page.getByRole("button", { name: "Streams", exact: true }).click();
  const row = page.getByRole("dialog", { name: "Streams" }).locator(".row", { hasText: target!.aceId });
  const remove = row.getByRole("button", { name: "Remove" });
  await remove.click();
  await expect(row.getByRole("button", { name: "Press again to remove" })).toBeVisible();
  await row.getByRole("button", { name: "Press again to remove" }).click();
  await expect(row).toBeHidden();
  await expect.poll(async () => streamById(request, target!.id)).toBeUndefined();
});
