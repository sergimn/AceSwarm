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

test("leaves full screen when Back comes before the browser went full screen", async ({ page }) => {
  // A TV can take a while to go full screen, and OK then Back at once on its remote closes the
  // player before it has. Here the browser goes full screen only once the player has closed.
  await page.addInitScript(`{
    const requestFullscreen = Element.prototype.requestFullscreen;
    window.fullscreenRequests = [];
    Element.prototype.requestFullscreen = function (options) {
      const closed = new Promise((resolve) => {
        const check = () => (this.hidden ? resolve() : setTimeout(check, 20));
        check();
      });
      const request = closed.then(() => requestFullscreen.call(this, options));
      window.fullscreenRequests.push(request.then(() => "entered", (error) => error.name));
      return request;
    };
  }`);
  await page.goto("/");
  const tile = page.locator(".tile", { hasText: "Channel 12" });
  await tile.focus();
  await page.keyboard.press("Enter");
  const player = page.getByRole("dialog", { name: "Player" });
  await expect(player).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(player).toBeHidden();

  // The browser went full screen after all, with the closed player: the page leaves it at once.
  expect(await page.evaluate<string[]>("Promise.all(window.fullscreenRequests)")).toEqual(["entered"]);
  await expect.poll(() => page.evaluate<boolean>("document.fullscreenElement === null")).toBe(true);
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 12/);
  // The grid answers the remote again.
  await page.keyboard.press("ArrowRight");
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 13/);
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
  // Its top comes only from the player (the styles have no default for it). The viewport can't be
  // changed here to try another shape: the browser refuses to resize a window in full screen.
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
  // The overlay with the Back button hides after a few seconds: moving the mouse brings it back.
  await player.hover();
  await player.getByRole("button", { name: "Back" }).click();
  await expect(player).toBeHidden();

  // The tile keeps focus, for the remote to go on from, but with the mouse it shows no details:
  // they would stay up, over its picture, and another tile under the mouse would show its own too.
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 12/);
  await expect.poll(() => detailsShown(page)).toEqual([]);
  await page.locator(".tile", { hasText: "Channel 13" }).hover();
  await expect.poll(() => detailsShown(page)).toEqual([expect.stringMatching(/^Channel 13,/)]);

  // The first key only shows where the keys are, on the tile that was open, and the tile under the
  // mouse gives way: Enter doesn't open a tile the person doesn't see as the one it acts on.
  await page.keyboard.press("Enter");
  await expect(player).toBeHidden();
  await expect(focused(page)).toHaveAttribute("aria-label", /Channel 12/);
  await expect.poll(() => detailsShown(page)).toEqual([expect.stringMatching(/^Channel 12,/)]);
  // The keys then go on from it.
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

test("reaches Settings at the bottom of the rail with the remote, and the browser keeps the tile previews", async ({
  page,
}) => {
  const network = page.getByRole("button", { name: "Network", exact: true });
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  /** From the first tile, which has the focus once the page opens, to Settings at the end of the rail. */
  const toSettings = async (): Promise<void> => {
    await expect(page.locator(".tile")).toHaveCount(3);
    await expect(page.locator(".tile").first()).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".rail-button:focus")).toHaveCount(1);
    // Three presses reach Settings from any button the tile leads to: Down stops there.
    for (let press = 0; press < 3; press += 1) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(settings).toBeFocused();
  };
  await page.goto("/");
  await toSettings();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Settings" });
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
  const saved: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH") {
      saved.push(request.url());
    }
  });
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

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
  // Moving the focus saved nothing: the preview choice stays in the browser.
  expect(saved).toEqual([]);
  // Up the rail, Streams lists the streams and no longer holds these settings.
  await page.keyboard.press("ArrowUp");
  await expect(network).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("button", { name: "Streams", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const streams = page.getByRole("dialog", { name: "Streams" });
  await expect(streams.locator(".row")).toHaveCount(3);
  await expect(streams.getByRole("switch")).toHaveCount(0);
  await expect(streams.getByRole("button", { name: "Thumbnails only" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(streams).toBeHidden();

  // Down at the end of the rail stays on Settings, and Right goes back to the streams: the
  // footer's links beside it lead out of the app.
  await page.keyboard.press("ArrowDown");
  await expect(network).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(settings).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(settings).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".tile:focus")).toHaveCount(1);

  // The choice is this browser's, and outlasts the page.
  await page.reload();
  await toSettings();
  await page.keyboard.press("Enter");
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
