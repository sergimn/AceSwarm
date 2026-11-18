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
  // The live stats are in a window over the picture, one to a line.
  await expect(player.locator('.player-stat[data-stat="state"] dd')).toHaveText("Live");
  await expect(player.locator(".player-stats")).toBeVisible();

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

  // The window sits 24 px in from the picture's left edge and a quarter of the way down it, black
  // bars left out. Without a picture to show (Chromium can't decode H.264), the whole screen counts.
  const statsOffset = `(() => {
    const player = document.querySelector(".player");
    const video = player.querySelector("video");
    const stats = player.querySelector(".player-stats").getBoundingClientRect();
    const shown = video.videoWidth > 0 && !player.matches(".waiting-for-source, .disabled");
    const scale = shown ? Math.min(player.clientWidth / video.videoWidth, player.clientHeight / video.videoHeight) : 1;
    const width = shown ? video.videoWidth * scale : player.clientWidth;
    const height = shown ? video.videoHeight * scale : player.clientHeight;
    const left = (player.clientWidth - width) / 2;
    const top = (player.clientHeight - height) / 2;
    // Adding 0 turns a -0 (a hair above) into 0, which toEqual tells apart.
    return [Math.round(stats.left - left) + 0, Math.round(stats.top - top - height / 4) + 0];
  })()`;
  await expect.poll(() => page.evaluate<number[]>(statsOffset)).toEqual([24, 0]);
  // It follows the screen: on a 4:3 one, a 16:9 picture leaves bars above and below.
  await page.setViewportSize({ width: 1280, height: 960 });
  await expect.poll(() => page.evaluate<number[]>(statsOffset)).toEqual([24, 0]);
  await page.setViewportSize({ width: 1280, height: 720 });

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
  // The first thumbnail is one ffmpeg writes once the stream's output is published, at most one
  // THUMBNAIL_INTERVAL_SECONDS (10) after its video started.
  await expect
    .poll(async () => (await request.get(first.hls.thumbnail)).headers()["content-type"], { timeout: 15_000 })
    .toContain("image/jpeg");
});
