import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { PathStatus, Snapshot, ViewerView } from "../../packages/shared/src/api-types.ts";
import { addStreamList, openApp, resetStack, snapshot, streamById, waitForPlaying } from "./helpers.ts";
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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The middle of the part two boxes share, if they share any. */
function overlap(a: Box, b: Box): { x: number; y: number } | undefined {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return left < right && top < bottom ? { x: (left + right) / 2, y: (top + bottom) / 2 } : undefined;
}

/**
 * How long, once a stream was handed to an external player or taken back, the player ignores
 * presses on the buttons that took the pressed one's place (`SWITCH_QUIET_MS` in the player), and a
 * little more.
 */
const SWITCH_QUIET_MS = 1200;

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
  await openApp(page);
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
  await openApp(page);
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
  await openApp(page);
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
  await openApp(page);
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

test("presses a button or a link once while OK is held down on the remote", async ({ page }) => {
  // Each screen the page opens (the player, a dialog) is a state it pushes onto the browser's history.
  await page.addInitScript(`(() => {
    window.screensOpened = 0;
    const push = history.pushState.bind(history);
    history.pushState = (...args) => {
      window.screensOpened += 1;
      return push(...args);
    };
  })()`);
  await openApp(page);
  const screensOpened = (): Promise<number> => page.evaluate<number>("window.screensOpened");
  /** OK held down: the key goes down, and goes down again every 100 ms, as a remote repeats it. */
  const holdOk = async (repeats: number): Promise<void> => {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      await page.keyboard.down("Enter");
      await page.waitForTimeout(100);
    }
    await page.keyboard.up("Enter");
  };
  const player = page.getByRole("dialog", { name: "Player" });
  const tile = page.locator(".tile", { hasText: "Channel 12" });

  // On a tile, the stream opens once. The repeats find the focus on the player's Back button.
  await tile.focus();
  await holdOk(10);
  await expect(player).toBeVisible();
  await expect(player.getByRole("button", { name: "Back" })).toBeFocused();
  expect(await screensOpened()).toBe(1);

  // On Back, the player closes and stays closed. The first press sends the focus back to the tile,
  // which the repeats would press, to open the stream again.
  await holdOk(20);
  await expect(player).toBeHidden();
  await expect(tile).toBeFocused();
  expect(await screensOpened()).toBe(1);

  // So does a dialog's close button, whose press leaves the focus on the button that opened it.
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  expect(await screensOpened()).toBe(2);
  await holdOk(20);
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
  expect(await screensOpened()).toBe(2);
});

test("hands a stream to an external player, and plays it here again", async ({ page, context, request, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  const stream = (await snapshot(request)).streams.find(({ name }) => name === "Channel 12");
  expect(stream).toBeDefined();
  // The playlist kept for players outside the page (the next test plays it).
  const address = new URL(stream!.hls.external, baseURL).href;
  expect(address).toContain(`/hls/${stream!.id}/external/index.m3u8`);
  const viewers = async (): Promise<number | undefined> => (await streamById(request, stream!.id))?.viewers;
  const videoSource = (): Promise<string | null> =>
    page.evaluate<string | null>(`document.querySelector(".player video").getAttribute("src")`);

  await page.locator(".tile", { hasText: "Channel 12" }).focus();
  await page.keyboard.press("Enter");
  const player = page.getByRole("dialog", { name: "Player" });
  await expect(player).toBeVisible();
  // With the remote: Back has the focus, and the button comes after Restart.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const open = player.getByRole("button", { name: "Open in external player" });
  await expect(open).toBeFocused();
  await expect.poll(() => page.evaluate<boolean>("document.fullscreenElement !== null")).toBe(true);
  await expect.poll(viewers).toBe(1);
  await expect.poll(videoSource).not.toBeNull();

  // Copy link is there from the start, for a browser that can't hand the stream over, and the page
  // plays on. A home network serves the app over plain HTTP, where browsers have no clipboard API
  // (here they have one, at 127.0.0.1): without it, the page copies the old way.
  const copy = player.getByRole("button", { name: "Copy link" });
  const toast = player.locator(".toast");
  await page.evaluate(`(() => {
    window.clipboardApi = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  })()`);
  // The controls fade after a few seconds, and a click doesn't reach them then: moving the mouse
  // shows them.
  await player.hover();
  await copy.click();
  await expect(toast).toHaveText("Link copied");
  expect(await page.evaluate<string>("window.clipboardApi.readText()")).toBe(address);
  await expect(copy).toBeFocused();
  expect(await videoSource()).not.toBeNull();
  // With the clipboard API again, and something else in the clipboard, for the copy further down.
  await page.evaluate(`(async () => {
    delete navigator.clipboard;
    await navigator.clipboard.writeText("something else");
  })()`);

  // OK held down on the remote repeats the key, here for longer than the moment after a hand-over
  // in which these buttons do nothing. Only the first press counts: the button gives its place and
  // the focus to the one that takes the stream back, which each repeat would press.
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await open.focus();
  await player.hover();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.keyboard.down("Enter");
      await page.keyboard.down("Enter");
      await page.waitForTimeout(SWITCH_QUIET_MS);
      await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
    })(),
  ]);
  // A desktop browser downloads a playlist file with the stream in it, at that address.
  expect(download.suggestedFilename()).toBe("Channel 12.m3u");
  expect(await readFile(await download.path(), "utf8")).toBe(`#EXTM3U\n#EXTINF:-1,Channel 12\n${address}\n`);

  // The player says what to do, where its picture was, while it is still full screen: the browser
  // hides its downloads there.
  const message = player.locator(".player-waiting");
  await expect(message).toContainText("Sent to an external player");
  await expect(message).toContainText(
    `Open "Channel 12.m3u" from your browser's downloads to start it. Leave full screen to see them.`,
  );
  await expect(message).toContainText(address);
  expect(await page.evaluate<boolean>("document.fullscreenElement !== null")).toBe(true);
  // The page stopped its own video, and nobody watches here.
  await expect.poll(videoSource).toBeNull();
  await expect.poll(viewers).toBe(0);
  await expect(open).toBeHidden();
  const resume = player.getByRole("button", { name: "Watch here again" });
  await expect(resume).toBeFocused();
  expect(downloads).toBe(1);

  // Copy link stays, for a player that didn't get the stream. The first toast is gone by now, or
  // goes within its five seconds, and the moment after the hand-over in which presses on these
  // buttons do nothing passed while OK was held.
  await expect(toast).toHaveCount(0);
  await player.hover();
  await copy.click();
  await expect(toast).toHaveText("Link copied");
  expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe(address);

  // And back: the page plays the stream again, and counts as its viewer. Presses that follow the
  // first at once, on the two buttons that are then where it was, do nothing: the stream isn't
  // handed over again, and its address isn't copied. The three come from one script in the page,
  // so that not even a slow runner puts a second between them.
  await page.evaluate(`navigator.clipboard.writeText("something else")`);
  await page.evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".player-actions button")];
    for (const name of ["Watch here again", "Open in external player", "Copy link"]) {
      buttons.find((button) => button.textContent.trim() === name).click();
    }
  })()`);
  await expect(message).toBeHidden();
  await expect(open).toBeFocused();
  await expect(resume).toBeHidden();
  await expect.poll(videoSource).not.toBeNull();
  await expect.poll(viewers).toBe(1);

  expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe("something else");

  await page.keyboard.press("Escape");
  await expect(player).toBeHidden();
  await expect.poll(viewers).toBe(0);
  expect(downloads).toBe(1);
});

test("counts a player outside the page as a viewer while it asks for the stream's own playlist", async ({
  request,
  playwright,
  baseURL,
}) => {
  const stream = (await snapshot(request)).streams.find(({ name }) => name === "Channel 12");
  expect(stream).toBeDefined();
  const { id, hls } = stream!;
  /** Who watches the stream: each viewer's id and device, in the order they came. */
  const watching = async (): Promise<ViewerView[]> =>
    ((await (await request.get("/api/viewers")).json()) as ViewerView[]).filter((viewer) => viewer.stream === id);
  const devices = async (): Promise<string[]> => (await watching()).map(({ device }) => device);
  const count = async (): Promise<number | undefined> => (await streamById(request, id))?.viewers;

  // The page's own playlist counts nobody: the page reports itself, and tests fetch it too.
  expect((await request.get(hls.full)).ok()).toBe(true);
  expect(await watching()).toEqual([]);

  // Two players, by what they call themselves.
  expect(baseURL).toBeDefined();
  const player = (userAgent: string) => playwright.request.newContext({ baseURL: baseURL!, userAgent });
  const vlc = await player("VLC/3.0.20 LibVLC/3.0.20");
  const ffmpeg = await player("Lavf/61.7.100");
  try {
    const playlist = await vlc.get(hls.external);
    expect(playlist.ok(), await playlist.text()).toBe(true);
    expect(playlist.headers()["content-type"]).toContain("application/vnd.apple.mpegurl");
    // It lists the full screen output's segments, at addresses that work from this playlist's.
    const newest = (await playlist.text()).split("\n").findLast((line) => line.endsWith(".ts"));
    expect(newest).toMatch(/^\.\.\/g\d+\/full\/seg_\d+\.ts$/);
    const segment = await vlc.get(new URL(newest!, new URL(hls.external, baseURL)).href);
    expect(segment.ok()).toBe(true);
    expect(segment.headers()["content-type"]).toBe("video/mp2t");

    // Getting the playlist made it a viewer, under a random id and its player's name.
    await expect.poll(devices).toEqual(["VLC"]);
    expect(await count()).toBe(1);
    const [first] = await watching();
    expect(first?.viewer).toMatch(/^[0-9a-f]{16}$/);
    // It asks again every few seconds: still the same viewer.
    expect((await vlc.get(hls.external)).ok()).toBe(true);
    expect((await watching()).map(({ viewer, since }) => ({ viewer, since }))).toEqual([
      { viewer: first?.viewer, since: first?.since },
    ]);
    // Another kind of player at the same address is another viewer.
    expect((await ffmpeg.get(hls.external)).ok()).toBe(true);
    await expect.poll(devices).toEqual(["VLC", "ffmpeg"]);
    expect(await count()).toBe(2);
  } finally {
    await vlc.dispose();
    await ffmpeg.dispose();
  }
  // They report nothing when they stop: they no longer count 30 seconds after their last request.
  await expect.poll(count, { timeout: 45_000 }).toBe(0);
  expect(await watching()).toEqual([]);
});

test("shows the details of one tile only: the one under the mouse, or the one the remote is on", async ({ page }) => {
  await openApp(page);
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
  await openApp(page);
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
  await openApp(page);
  await toSettings();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Settings" });
  const previews = dialog.getByRole("group", { name: "Tile previews" });
  const video = previews.getByRole("button", { name: "Live video" });
  const thumbnails = previews.getByRole("button", { name: "Thumbnails only" });
  const sharing = dialog.getByRole("switch", { name: "One engine per path" });
  const standby = dialog.getByRole("switch", { name: "Hot standby on other paths" });
  const favourite = dialog.getByRole("group", { name: "Favourite path" });
  await expect(dialog).toBeVisible();
  await expect(video).toHaveAttribute("aria-pressed", "true");
  await expect(thumbnails).toHaveAttribute("aria-pressed", "false");
  // `resetStack` turned both off, and left no favourite path.
  await expect(sharing).toHaveAttribute("aria-checked", "false");
  await expect(standby).toHaveAttribute("aria-checked", "false");
  await expect(favourite.getByRole("button", { name: "None", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(favourite.getByRole("button", { name: "Direct", exact: true })).toHaveAttribute("aria-pressed", "false");
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
  // The choices for the favourite path are under it.
  await page.keyboard.press("ArrowDown");
  await expect(favourite.locator(".segment:focus")).toHaveCount(1);
  await expect(sharing).toHaveAttribute("aria-checked", "false");
  await expect(standby).toHaveAttribute("aria-checked", "false");
  await expect(favourite.getByRole("button", { name: "None", exact: true })).toHaveAttribute("aria-pressed", "true");

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

test("shows thumbnails only while the admin allows nothing else, whatever the browser chose", async ({
  page,
  request,
}) => {
  // The stack runs without LOW_CPU_PREVIEWS, so browsers choose. Here the page gets the
  // snapshots a controller sends with it set while `thumbnailsOnly` says so.
  expect((await snapshot(request)).tilePreviews).toEqual({ thumbnailsOnly: false });
  let thumbnailsOnly = true;
  const current = async (): Promise<Snapshot> => ({
    ...(await snapshot(request)),
    tilePreviews: { thumbnailsOnly },
  });
  await page.route("**/api/snapshot", async (route) => {
    await route.fulfill({ json: await current() });
  });
  await page.route("**/api/events", async (route) => {
    // One snapshot, then the browser opens the stream again a second later, as after a dropped one.
    await route.fulfill({
      contentType: "text/event-stream",
      body: `retry: 1000\nevent: snapshot\ndata: ${JSON.stringify(await current())}\n\n`,
    });
  });
  // This browser chose Live video before the admin restricted it. Every later write of its choice
  // is kept in `choiceWrites`, even one that writes the same choice again.
  await page.addInitScript(() => {
    localStorage.setItem("aceswarm.previewMode", "video");
    const writes: string[] = [];
    Object.assign(globalThis, { choiceWrites: writes });
    const setItem: unknown = Reflect.get(Storage.prototype, "setItem");
    Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
      if (key === "aceswarm.previewMode") {
        writes.push(value);
      }
      Reflect.apply(setItem as Storage["setItem"], this, [key, value]);
    };
  });
  const choiceWrites = (): Promise<string[]> => page.evaluate<string[]>("choiceWrites");
  const previewLoads: string[] = [];
  const saved: string[] = [];
  page.on("request", (sent) => {
    if (new URL(sent.url()).pathname.includes("/preview/")) {
      previewLoads.push(sent.url());
    }
    if (sent.method() === "PATCH") {
      saved.push(sent.url());
    }
  });
  await openApp(page);
  await expect(page.locator(".tile")).toHaveCount(3);
  await expect(page.locator(".tile").first()).toBeFocused();
  // The test above reaches Settings with the remote; this one is about what it shows.
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Settings" });
  const previews = dialog.getByRole("group", { name: "Tile previews" });
  const video = previews.getByRole("button", { name: "Live video" });
  const thumbnails = previews.getByRole("button", { name: "Thumbnails only" });
  const tip = dialog.getByRole("tooltip");
  const why = "Your admin has restricted this feature to save resources. Contact them for any questions";
  await expect(dialog).toBeVisible();
  await expect(thumbnails).toHaveAttribute("aria-pressed", "true");
  await expect(video).toHaveAttribute("aria-pressed", "false");
  await expect(video).toHaveAttribute("aria-disabled", "true");
  await expect(video).toHaveCSS("opacity", "0.5");
  await expect(video).toHaveAccessibleDescription(why);
  await expect(tip).toBeHidden();

  // The remote reaches the greyed out choice, and its focus shows why. OK on either choice changes
  // nothing.
  await page.keyboard.press("ArrowDown");
  await expect(thumbnails).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowLeft");
  await expect(video).toBeFocused();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText(why);
  await page.keyboard.press("Enter");
  await expect(video).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("ArrowRight");
  await expect(thumbnails).toBeFocused();
  await expect(tip).toBeHidden();

  // The mouse over it shows why too, and a click changes nothing either.
  await video.hover();
  await expect(tip).toBeVisible();
  // Playwright waits for a control marked aria-disabled to be enabled before it clicks; a person doesn't.
  await video.click({ force: true });
  await expect(video).toHaveAttribute("aria-pressed", "false");
  await expect(thumbnails).toHaveAttribute("aria-pressed", "true");
  // The click left focus on Live video, but with the pointer gone the tip goes: it covers the next
  // setting's switch at this size.
  await page.mouse.move(0, 0);
  await expect(video).toBeFocused();
  await expect(tip).toBeHidden();
  // The pointer can move onto the tip, and a press there presses nothing under it.
  const sharing = dialog.getByRole("switch", { name: "One engine per path" });
  const sharingWas = await sharing.getAttribute("aria-checked");
  await video.hover();
  await tip.hover({ timeout: 5000 });
  await expect(tip).toBeVisible();
  const covered = overlap((await tip.boundingBox())!, (await sharing.boundingBox())!);
  expect(covered, "the tip covers the switch").toBeDefined();
  await page.mouse.click(covered!.x, covered!.y);
  await expect(sharing).toHaveAttribute("aria-checked", sharingWas!);
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  // A press on the switch would have saved its setting (the switch only turns once that is done):
  // nothing was saved. The browser's own choice stays as it was, and no tile asked for a live preview.
  expect(await choiceWrites()).toEqual([]);
  expect(await page.evaluate<string | null>('localStorage.getItem("aceswarm.previewMode")')).toBe("video");
  expect(saved).toEqual([]);
  expect(previewLoads).toEqual([]);

  // Once the admin lifts it, the browser's choice is back, and the tiles play again.
  thumbnailsOnly = false;
  await expect(video).toHaveAttribute("aria-pressed", "true");
  await expect(video).not.toHaveAttribute("aria-disabled");
  await expect(thumbnails).toHaveAttribute("aria-pressed", "false");
  await expect(tip).toBeHidden();
  await expect.poll(() => previewLoads.length).toBeGreaterThan(0);

  // The admin restricts it again while the page is open: Live video greys out in the open dialog,
  // and the tiles stop their previews.
  thumbnailsOnly = true;
  await expect(video).toHaveAttribute("aria-disabled", "true");
  await expect(thumbnails).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".tile video[src]")).toHaveCount(0);
  const loaded = previewLoads.length;
  // With Live video, each tile would have asked for its preview again by now: it tries again within
  // twice RETRY_MS of apps/ui/src/previews.ts, 10 s.
  await page.waitForTimeout(11_000);
  expect(previewLoads).toHaveLength(loaded);
  expect(await choiceWrites()).toEqual([]);
  expect(saved).toEqual([]);
  // The page asks for snapshots until it closes, after the test's own request context is gone.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("the favourite path's choice that has the focus keeps it while paths come and go", async ({ page, request }) => {
  // The stack has the direct path alone. Here the page gets the snapshots a controller sends with
  // the WireGuard paths in `profiles` as well, as while profiles are added and removed elsewhere.
  const real = await snapshot(request);
  expect(real.paths.map(({ id }) => id)).toEqual(["direct"]);
  const vpn = (label: string): PathStatus => ({ ...real.paths[0]!, id: `wg:${label}`, kind: "wireguard", label });
  let profiles = ["zeta"];
  const current = async (): Promise<Snapshot> => {
    const now = await snapshot(request);
    return { ...now, paths: [...now.paths, ...profiles.map((label) => vpn(label))] };
  };
  await page.route("**/api/snapshot", async (route) => {
    await route.fulfill({ json: await current() });
  });
  await page.route("**/api/events", async (route) => {
    // One snapshot, then the browser opens the stream again a second later, as after a dropped one.
    await route.fulfill({
      contentType: "text/event-stream",
      body: `retry: 1000\nevent: snapshot\ndata: ${JSON.stringify(await current())}\n\n`,
    });
  });
  await openApp(page);
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Enter");
  const favourite = page.getByRole("dialog", { name: "Settings" }).getByRole("group", { name: "Favourite path" });
  const choices = favourite.getByRole("button");
  const zeta = favourite.getByRole("button", { name: "zeta", exact: true });
  await expect(choices).toHaveText(["None", "Direct", "zeta"]);
  await zeta.focus();
  await expect(zeta).toBeFocused();

  // A path listed before it: the choices are drawn in their new order, and the focus stays.
  profiles = ["alpha", "zeta"];
  await expect(choices).toHaveText(["None", "Direct", "alpha", "zeta"]);
  await expect(zeta).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(favourite.getByRole("button", { name: "alpha", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(zeta).toBeFocused();

  // Its own path goes: the focus goes to the first choice, not out of the dialog.
  profiles = ["alpha"];
  await expect(choices).toHaveText(["None", "Direct", "alpha"]);
  await expect(favourite.getByRole("button", { name: "None", exact: true })).toBeFocused();
  // The page asks for snapshots until it closes, after the test's own request context is gone.
  await page.unrouteAll({ behavior: "ignoreErrors" });
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

test("ends the hand-over when the stream is disabled, and plays it in the page once it is enabled", async ({
  page,
  request,
}) => {
  await openApp(page);
  const stream = (await snapshot(request)).streams.find(({ name }) => name === "Channel 13");
  expect(stream).toBeDefined();
  const enabled = async (value: boolean): Promise<void> => {
    const response = await request.patch(`/api/streams/${stream!.id}`, { data: { enabled: value } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const videoSource = (): Promise<string | null> =>
    page.evaluate<string | null>(`document.querySelector(".player video").getAttribute("src")`);

  await page.locator(".tile", { hasText: "Channel 13" }).click();
  const player = page.getByRole("dialog", { name: "Player" });
  await expect(player).toBeVisible();
  const open = player.getByRole("button", { name: "Open in external player" });
  const resume = player.getByRole("button", { name: "Watch here again" });
  const copy = player.getByRole("button", { name: "Copy link" });
  const message = player.locator(".player-waiting");
  // A double click hands the stream over once: its second click lands where the button that takes
  // the stream back just went, and does nothing. Both clicks reach the page together, whatever the
  // runner's speed.
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await player.hover();
  await Promise.all([page.waitForEvent("download"), open.dblclick()]);
  await expect(message).toContainText("Sent to an external player");
  await expect(resume).toBeFocused();
  await expect(player.locator(".toast")).toHaveCount(0);
  // Long enough for the controls to fade: the focus must not get lost behind them either.
  await page.waitForTimeout(5000);
  expect(downloads).toBe(1);
  expect(await videoSource()).toBeNull();

  try {
    // Disabled under the external player, which lost its playlist: the page says so, the buttons for
    // a stream that has an output go, and the focus moves from the one that went to Back.
    await enabled(false);
    await expect(message).toContainText("This stream is disabled");
    await expect(player.getByRole("button", { name: "Enable stream" })).toBeVisible();
    await expect(open).toBeHidden();
    await expect(resume).toBeHidden();
    await expect(copy).toBeHidden();
    await expect(player.getByRole("button", { name: "Back" })).toBeFocused();
    expect(await videoSource()).toBeNull();
  } finally {
    await enabled(true);
  }
  // Enabled again, the page plays it by itself: the hand-over ended with the stream.
  await expect(message).not.toContainText("This stream is disabled");
  await expect(message).not.toContainText("Sent to an external player");
  await expect(open).toBeVisible();
  await expect(copy).toBeVisible();
  await expect(resume).toBeHidden();
  await expect.poll(videoSource).not.toBeNull();
  await waitForPlaying(request, stream!.id);
});

test.describe("in a browser on Android", () => {
  // A TV's browser, by what it says of itself. It is still this desktop browser: the test shows what
  // the page does there, not what Android then does with the link.
  test.use({
    userAgent:
      "Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });

  test("hands a stream over through an intent link, and keeps its address on screen when it can't copy it", async ({
    page,
    request,
    baseURL,
  }) => {
    // The links the page follows are noted, not followed: nothing here opens an app. And this
    // browser can't copy, neither with the clipboard API nor the old way.
    await page.addInitScript(`(() => {
      window.followed = [];
      document.addEventListener(
        "click",
        (event) => {
          if (event.target instanceof HTMLAnchorElement) {
            const { href, download } = event.target;
            window.followed.push({ href, download });
            event.preventDefault();
          }
        },
        true,
      );
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      document.execCommand = () => false;
    })()`);
    let downloads = 0;
    page.on("download", () => {
      downloads += 1;
    });
    await openApp(page);
    const stream = (await snapshot(request)).streams.find(({ name }) => name === "Channel 11");
    expect(stream).toBeDefined();
    const address = new URL(stream!.hls.external, baseURL);

    await page.locator(".tile", { hasText: "Channel 11" }).click();
    const player = page.getByRole("dialog", { name: "Player" });
    await expect(player).toBeVisible();
    const videoSource = (): Promise<string | null> =>
      page.evaluate<string | null>(`document.querySelector(".player video").getAttribute("src")`);
    await expect.poll(videoSource).not.toBeNull();

    // Copy link first, as in a browser that might not come back from the link. The address it
    // couldn't copy shows under the stream's name, to write down: it stays, and the controls with
    // it, past the few seconds after which they fade. It is above the stats window, over nothing.
    const copy = player.getByRole("button", { name: "Copy link" });
    const note = player.locator(".player-address");
    await expect(note).toBeHidden();
    await player.hover();
    await copy.click();
    await expect(note).toHaveText(`This browser doesn't let the page copy. The address is ${address.href}`);
    await page.waitForTimeout(7000);
    await expect(note).toBeVisible();
    await expect(player).toHaveClass(/show-overlay/);
    const noteBox = await note.boundingBox();
    const statsBox = await player.locator(".player-stats").boundingBox();
    expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(statsBox!.y);
    expect(await videoSource()).not.toBeNull();

    // Closing the player takes the address away: the stream opens without it.
    await page.keyboard.press("Escape");
    await expect(player).toBeHidden();
    await page.locator(".tile", { hasText: "Channel 11" }).click();
    await expect(player).toBeVisible();
    await expect(note).toBeHidden();
    await expect.poll(videoSource).not.toBeNull();

    // So does disabling the stream, which has no address to give out then.
    await player.hover();
    await copy.click();
    await expect(note).toBeVisible();
    const enabled = async (value: boolean): Promise<void> => {
      const response = await request.patch(`/api/streams/${stream!.id}`, { data: { enabled: value } });
      expect(response.ok(), await response.text()).toBe(true);
    };
    try {
      await enabled(false);
      await expect(copy).toBeHidden();
      await expect(note).toBeHidden();
    } finally {
      await enabled(true);
    }
    await expect(copy).toBeVisible();

    // And so does a copy that works, as if the browser had allowed it meanwhile.
    await player.hover();
    await copy.click();
    await expect(note).toBeVisible();
    await page.evaluate("document.execCommand = () => true");
    await copy.click();
    await expect(player.locator(".toast")).toHaveText("Link copied");
    await expect(note).toBeHidden();
    await page.evaluate("document.execCommand = () => false");

    // The button follows a link that asks Android to open the playlist in an app, and downloads no
    // file. The message has the address from then on, so the line under the name goes.
    await player.hover();
    await copy.click();
    await expect(note).toBeVisible();
    await player.getByRole("button", { name: "Open in external player" }).click();
    const message = player.locator(".player-waiting");
    await expect(message).toContainText("Sent to an external player");
    await expect(message).toContainText("Pick a player if your device asks for one.");
    await expect(message).toContainText(`If none opens, open this address in your player: ${address.href}`);
    await expect(note).toBeHidden();
    expect(await page.evaluate("window.followed")).toEqual([
      {
        href: `intent://${address.host}${address.pathname}#Intent;scheme=http;action=android.intent.action.VIEW;type=application/vnd.apple.mpegurl;end`,
        download: "",
      },
    ]);
    expect(downloads).toBe(0);
    await expect(player.getByRole("button", { name: "Watch here again" })).toBeFocused();
    await expect.poll(videoSource).toBeNull();

    await page.keyboard.press("Escape");
    await expect(player).toBeHidden();
    // The stream is left as it was found, playing: it was disabled for a moment.
    await waitForPlaying(request, stream!.id);
  });
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, viewport: { width: 412, height: 915 } });

  test("a tap brings the player's controls back and presses nothing, and one tap presses a button that shows", async ({
    page,
  }) => {
    await openApp(page);
    await page.locator(".tile", { hasText: "Channel 12" }).tap();
    const player = page.getByRole("dialog", { name: "Player" });
    await expect(player).toBeVisible();
    const shown = /show-overlay/;
    // The buttons that get pressed, by their words.
    await page.evaluate(`(() => {
      window.pressed = [];
      document.querySelector(".player-actions").addEventListener(
        "click",
        (event) => window.pressed.push(event.target.closest("button")?.textContent.trim()),
        true,
      );
    })()`);
    const pressed = (): Promise<string[]> => page.evaluate<string[]>("window.pressed");
    const centre = async (selector: string): Promise<{ x: number; y: number }> => {
      const box = await player.locator(selector).boundingBox();
      return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    };

    // The controls fade a few seconds after the last touch, and a finger moves no pointer over the
    // player to bring them back: a tap on the picture does.
    await expect(player).toHaveClass(shown);
    await expect(player).not.toHaveClass(shown);
    const picture = await centre(".player-video");
    await page.touchscreen.tap(picture.x, picture.y);
    await expect(player).toHaveClass(shown);

    // So does a tap where Back is, which they hide: it presses nothing, the controls show once it is
    // over.
    await expect(player).not.toHaveClass(shown);
    const back = await centre(".player-actions button:first-child");
    await page.touchscreen.tap(back.x, back.y);
    await expect(player).toHaveClass(shown);
    expect(await pressed()).toEqual([]);
    await expect(player).toBeVisible();

    // A tap on a button that shows presses it once.
    await page.touchscreen.tap(back.x, back.y);
    await expect(player).toBeHidden();
    expect(await pressed()).toEqual(["Back"]);
  });
});
