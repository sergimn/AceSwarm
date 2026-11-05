import { expect, test, type Page } from "@playwright/test";
import { addStream, mockId, resetStack, waitForPlaying } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await resetStack(request);
  for (const seed of [11, 12, 13]) {
    const stream = await addStream(request, mockId("c", "content-id", seed), `Channel ${String(seed)}`);
    await waitForPlaying(request, stream.id);
  }
});

/** The focused element, checked by its accessible label (tiles are labelled "<name>, <state>"). */
function focused(page: Page) {
  return page.locator(":focus");
}

test("moves between tiles with the arrow keys", async ({ page }) => {
  await page.goto("/");
  const tiles = page.locator(".tile");
  await expect(tiles).toHaveCount(3);
  await tiles.first().focus();
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 11/);

  await page.keyboard.press("ArrowRight");
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 12/);
  await page.keyboard.press("ArrowLeft");
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 11/);

  // Left of the first tile is the action rail.
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".rail-button:focus")).toHaveCount(1);
});

test("reaches the rail from the grid on a large screen too", async ({ page }) => {
  // At this size the footer link is just left of the first column's centre and scrolls with the
  // tiles, while the rail stays put. Left must still pick the rail beside the tile.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.locator(".tile").first().focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".rail-button:focus")).toHaveCount(1);
});

test("opens a stream full screen and goes back with the remote's Back key", async ({ page }) => {
  await page.goto("/");
  const tile = page.locator(".tile", { hasText: "Channel 12" });
  await tile.focus();
  await page.keyboard.press("Enter");

  const player = page.getByRole("dialog", { name: "Player" });
  await expect(player).toBeVisible();
  await expect(player.locator(".player-title")).toHaveText("Channel 12");
  await expect(player.locator(".player-details")).toContainText("Live");

  // Chromium builds without H.264 can't decode the stream; Google Chrome (PW_CHANNEL=chrome) can.
  // The specs run in Node without DOM types, so browser-side code is passed as strings.
  const canPlayH264 = await page.evaluate<boolean>(
    `MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028,mp4a.40.2"')`,
  );
  if (canPlayH264) {
    await expect
      .poll(() => page.evaluate<number>(`document.querySelector(".player video").currentTime`), { timeout: 60_000 })
      .toBeGreaterThan(1);
  }

  await page.keyboard.press("Escape");
  await expect(player).toBeHidden();
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 12/);
});

test("closes dialogs with Back and returns focus", async ({ page }) => {
  await page.goto("/");
  const network = page.getByRole("button", { name: "Network", exact: true });
  await network.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Network" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".row", { hasText: "Direct" })).toContainText("Up");

  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(network).toBeFocused();
});

test("serves previews and thumbnails for the grid", async ({ request }) => {
  const stream = (await (await request.get("/api/streams")).json()) as {
    hls: { preview: string; thumbnail: string };
  }[];
  const first = stream[0]!;
  const playlist = await request.get(first.hls.preview);
  expect(playlist.ok()).toBe(true);
  expect(await playlist.text()).toContain("#EXTINF");
  const thumbnail = await request.get(first.hls.thumbnail);
  expect(thumbnail.headers()["content-type"]).toContain("image/jpeg");
});
