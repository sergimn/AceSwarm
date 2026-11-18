import { expect, test, type Page } from "@playwright/test";
import { addStreamList, resetStack, waitForPlaying } from "./helpers.ts";
import { broadcasts } from "./mesh.ts";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await resetStack(request);
  const [first, second, third] = await broadcasts(3);
  // One pasted list, a line of each kind: its streams start right away, side by side.
  const streams = await addStreamList(request, [
    first!.infohash,
    `acestream://${second!.contentId}`,
    `magnet:?xt=urn:btih:${third!.infohash}`,
  ]);
  for (const stream of streams) {
    await waitForPlaying(request, stream.id);
  }
  // A list gives its streams no names: the tests below find them by these.
  for (const [index, stream] of streams.entries()) {
    const renamed = await request.patch(`/api/streams/${stream.id}`, {
      data: { name: `Channel ${String(index + 11)}` },
    });
    expect(renamed.ok(), await renamed.text()).toBe(true);
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

test("reaches Options at the bottom of the rail with the remote, and the browser keeps the tile previews", async ({
  page,
}) => {
  await page.goto("/");
  // Once the page has its streams it has also moved the focus to the first tile, as it does when
  // it opens: from here on the focus is the test's.
  await expect(page.locator(".tile")).toHaveCount(3);
  const network = page.getByRole("button", { name: "Network", exact: true });
  const options = page.getByRole("button", { name: "Options", exact: true });
  await network.focus();
  await page.keyboard.press("ArrowDown");
  await expect(options).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Options" });
  const previews = dialog.getByRole("group", { name: "Tile previews" });
  const video = previews.getByRole("button", { name: "Live video" });
  const thumbnails = previews.getByRole("button", { name: "Thumbnails only" });
  const sharing = dialog.getByRole("switch", { name: "One engine per path" });
  const standby = dialog.getByRole("switch", { name: "Hot standby on other paths" });
  await expect(dialog).toBeVisible();
  await expect(video).toHaveAttribute("aria-pressed", "true");
  await expect(thumbnails).toHaveAttribute("aria-pressed", "false");
  // `resetStack` turned both off.
  await expect(sharing).toHaveAttribute("aria-checked", "false");
  await expect(standby).toHaveAttribute("aria-checked", "false");
  // The dialog opens on its close button. Down goes through the settings on the right, and only
  // OK presses them.
  await page.keyboard.press("ArrowDown");
  await expect(thumbnails).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(thumbnails).toHaveAttribute("aria-pressed", "true");
  await expect(video).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("ArrowDown");
  await expect(sharing).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(standby).toBeFocused();
  await expect(sharing).toHaveAttribute("aria-checked", "false");
  await expect(standby).toHaveAttribute("aria-checked", "false");

  // The Streams dialog lists the streams and no longer holds these settings.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(options).toBeFocused();
  await page.getByRole("button", { name: "Streams", exact: true }).click();
  const streams = page.getByRole("dialog", { name: "Streams" });
  await expect(streams.locator(".row")).toHaveCount(3);
  await expect(streams.getByRole("switch")).toHaveCount(0);
  await expect(streams.getByRole("button", { name: "Thumbnails only" })).toHaveCount(0);

  // The choice is this browser's, and outlasts the page.
  await page.reload();
  await expect(page.locator(".tile")).toHaveCount(3);
  await options.click();
  await expect(thumbnails).toHaveAttribute("aria-pressed", "true");
  await expect(video).toHaveAttribute("aria-pressed", "false");
});

test("serves previews and thumbnails for the grid", async ({ request }) => {
  const stream = (await (await request.get("/api/streams")).json()) as {
    hls: { preview: string; thumbnail: string };
  }[];
  const first = stream[0]!;
  const playlist = await request.get(first.hls.preview);
  expect(playlist.ok()).toBe(true);
  expect(await playlist.text()).toContain("#EXTINF");
  // The first thumbnail is one ffmpeg writes once the stream's output is published, at most one
  // THUMBNAIL_INTERVAL_SECONDS (10) after its video started.
  await expect
    .poll(async () => (await request.get(first.hls.thumbnail)).headers()["content-type"], { timeout: 15_000 })
    .toContain("image/jpeg");
});
