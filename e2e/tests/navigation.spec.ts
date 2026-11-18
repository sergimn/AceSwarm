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

/**
 * The labels of the tiles that show their details (Freshness, Peers...): those slide up over the
 * picture, and stay below it, out of sight, on the others. Read once they stopped sliding, since a
 * tile whose details are on their way up shows none yet.
 */
async function detailsShown(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(async () => {
    const tiles = [...document.querySelectorAll(".tile")];
    const offset = (tile) => new DOMMatrix(getComputedStyle(tile.querySelector(".tile-stats")).transform).f;
    tiles.forEach(offset);
    const slides = document.getAnimations().filter((animation) => animation instanceof CSSTransition);
    await Promise.all(slides.map((slide) => slide.finished.catch(() => undefined)));
    return tiles.filter((tile) => offset(tile) === 0).map((tile) => tile.getAttribute("aria-label"));
  })()`);
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
  // With the remote, the tile it is on shows its details.
  await expect.poll(() => detailsShown(page)).toEqual([expect.stringMatching(/^Channel 12,/)]);
});

test("shows the details of one tile only: the one under the mouse, or the one the remote is on", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tile", { hasText: "Channel 12" }).click();
  const player = page.getByRole("dialog", { name: "Player" });
  await expect(player).toBeVisible();
  // As a person sees it: the player full screen, before they go back.
  await expect.poll(() => page.evaluate<boolean>("document.fullscreenElement !== null")).toBe(true);
  await player.getByRole("button", { name: "Back" }).click();
  await expect(player).toBeHidden();

  // The tile keeps focus, for the remote to go on from, but with the mouse it shows no details:
  // they would stay up, over its picture, and another tile under the mouse would show its own too.
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 12/);
  await expect.poll(() => detailsShown(page)).toEqual([]);
  await page.locator(".tile", { hasText: "Channel 13" }).hover();
  await expect.poll(() => detailsShown(page)).toEqual([expect.stringMatching(/^Channel 13,/)]);

  // The keys go on from the tile that was open, and the tile under the mouse gives way.
  await page.keyboard.press("ArrowLeft");
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 11/);
  await expect.poll(() => detailsShown(page)).toEqual([expect.stringMatching(/^Channel 11,/)]);
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
