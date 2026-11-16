import { expect, test } from "@playwright/test";
import {
  addStream,
  compose,
  docker,
  engineContainers,
  resetStack,
  snapshot,
  streamById,
  waitForPlaying,
} from "./helpers.ts";
import { broadcasts, type Broadcast } from "./mesh.ts";

test.describe.configure({ mode: "serial" });

/** The broadcasts on the broadcast runner; each test plays its own. */
const bc: Broadcast[] = [];

test.beforeAll(async ({ request }) => {
  await resetStack(request);
  bc.push(...(await broadcasts(3)));
});

test("adds a stream by its acestream:// link from the UI and shows its live stats", async ({ page, request }) => {
  const { contentId } = bc[0]!;
  await page.goto("/");
  await expect(page.locator("#empty")).toBeVisible();

  await page.getByRole("button", { name: "Add a stream" }).click();
  const dialog = page.getByRole("dialog", { name: "Add stream" });
  await dialog.getByLabel("Acestream ID or infohash").fill(`acestream://${contentId}`);
  await dialog.getByLabel("Name").fill("Test pattern");
  await dialog.getByRole("button", { name: "Add stream" }).click();
  await expect(dialog).toBeHidden();

  const tile = page.locator(".tile", { hasText: "Test pattern" });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("data-state", "playing", { timeout: 180_000 });

  // Stats show on hover (and on focus with a remote).
  await tile.hover();
  const stats = tile.locator(".tile-stats");
  await expect(stats).toBeVisible();
  await expect(stats.locator(".stat", { hasText: "Freshness" })).toContainText("Now");
  await expect(stats.locator(".stat", { hasText: "Peers" })).toContainText(/[1-9]\d* (sending|connected)/);
  // The broadcast runner is the peer, placed in Spain (GEOIP_STATIC in e2e/compose.e2e.yaml).
  await expect(stats.locator(".country-code")).toHaveText(["ES"]);
  await expect(stats.locator(".fi.fi-es")).toBeAttached();
  await expect(stats.locator(".stat", { hasText: "Download" })).toContainText(/KB\/s|MB\/s/);

  // A bare value (acestream:// links carry one) is tried as a content ID first, which works here.
  const stream = (await snapshot(request)).streams.find((candidate) => candidate.aceId === contentId);
  expect(stream?.aceIdKind).toBe("content-id");
});

test("shows ages by the controller's clock when the browser's clock is wrong", async ({ page }) => {
  // A TV whose clock is 5 minutes fast, as one whose time was never set can be: measured against
  // it, every frame would be minutes old.
  await page.addInitScript(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 5 * 60_000;
  });
  await page.goto("/");
  // The page's clock really is that far off the controller's.
  const skewMs = await page.evaluate(async () => {
    const generatedAt = ((await (await fetch("/api/snapshot")).json()) as { generatedAt: string }).generatedAt;
    return Date.now() - Date.parse(generatedAt);
  });
  expect(skewMs).toBeGreaterThan(4 * 60_000);

  const tile = page.locator(".tile", { hasText: "Test pattern" });
  await expect(tile).toHaveAttribute("data-state", "playing", { timeout: 60_000 });
  await tile.hover();
  const age = tile.locator(".stat", { hasText: "Freshness" }).locator(".stat-value");
  await expect(age).toHaveText("Now");
  await expect(age).toHaveClass(/\bfresh\b/);

  // The player's "Last frame" is measured on the same clock.
  await tile.click();
  const player = page.getByRole("dialog", { name: "Player" });
  await expect(player.locator(".player-details")).toContainText("Last frame: Now");
  await player.getByRole("button", { name: "Back" }).click();
  await expect(player).toBeHidden();
});

test("says when it hears nothing from the controller, and recovers when it does again", async ({ page }) => {
  // Every connection to the event stream is refused, as a reverse proxy does while the controller
  // restarts: the browser gives up on the stream for good, and the page opens new ones.
  await page.route("**/api/events", (route) => route.fulfill({ status: 502, body: "bad gateway" }));
  await page.goto("/");
  const tile = page.locator(".tile", { hasText: "Test pattern" });
  await expect(tile).toHaveAttribute("data-state", "playing", { timeout: 60_000 });
  await tile.hover();
  const age = tile.locator(".stat", { hasText: "Freshness" }).locator(".stat-value");
  await expect(age).toHaveText("Now");

  // No snapshot follows the first: after a few seconds what the page shows is old, and it says so.
  await expect(page.locator("body")).toHaveAttribute("data-stale", "", { timeout: 30_000 });
  await expect(page.locator("#connection")).toHaveText(/^Reconnecting… last update \d+s ago$/);
  await expect(age).toHaveText(/^\d+s ago$/);
  await expect(age).not.toHaveClass(/\bfresh\b/);

  // The player covers the top bar, so it says so too, and its overlay stays up: it would fade after
  // 4 s, which leaves a frozen picture with no cue.
  await tile.click();
  const player = page.getByRole("dialog", { name: "Player" });
  await expect(player.locator(".player-connection")).toHaveText(/^Reconnecting… last update \d+s ago$/);
  // Its clock shows too, whether or not the browser let it enter full screen.
  await expect(player.locator(".player-clock")).toHaveText(/^\d\d:\d\d$/);
  await page.waitForTimeout(5500);
  await expect(player).toHaveClass(/\bshow-overlay\b/);
  await player.getByRole("button", { name: "Back" }).click();
  await expect(player).toBeHidden();

  // Once the controller answers again, a new event stream opens by itself.
  await page.unroute("**/api/events");
  await expect(page.locator("body")).not.toHaveAttribute("data-stale", "", { timeout: 30_000 });
  await expect(page.locator("#connection")).toHaveText("Live");
  await expect(age).toHaveText("Now");
});

test("exports the engine's memory cache cap and estimated use, and the peers it uploads to", async ({ request }) => {
  const stream = (await snapshot(request)).streams.find((candidate) => candidate.aceId === bc[0]!.contentId);
  expect(stream).toBeDefined();
  const value = async (series: string): Promise<number | undefined> => {
    const text = await (await request.get("/metrics")).text();
    const match = new RegExp(String.raw`^${series} (\S+)$`, "m").exec(text);
    return match === null ? undefined : Number(match[1]);
  };
  // Prometheus adds labels of its own, such as service.
  const engine = String.raw`\{stream="${stream!.id}",engine="[^"]+"[^}]*\}`;
  // The default ENGINE_MEMORY_CACHE_MB (128).
  await expect
    .poll(() => value(`aceswarm_engine_memory_cache_limit_bytes${engine}`), { timeout: 60_000 })
    .toBe(128 * 1024 * 1024);
  const cache = await value(`aceswarm_engine_memory_cache_bytes${engine}`);
  expect(cache).toBeGreaterThanOrEqual(0);
  expect(cache).toBeLessThanOrEqual(128 * 1024 * 1024);
  // The broadcast runner is the only peer and needs nothing from us, so the engine reports no upload
  // and no peer counts as uploading, in any of six gateway samples in a row soon after playback
  // starts. The gateway alone sometimes counted the engine's other traffic to it as an upload.
  const uploading = String.raw`aceswarm_stream_peers\{stream="${stream!.id}",kind="uploading"[^}]*\}`;
  await expect.poll(() => value(uploading)).toBeDefined();
  for (let sample = 0; sample < 6; sample++) {
    const count = await value(uploading);
    if (count !== 0) {
      // Which remote it was: the gateway's connections of the engine, with their byte counters.
      await test
        .info()
        .attach("gateway flows of the engine", { body: engineFlows(stream!.id), contentType: "text/plain" });
    }
    expect(count, `sample ${String(sample)}`).toBe(0);
    expect((await streamById(request, stream!.id))?.uploadKBps, `sample ${String(sample)}`).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
});

/** The gateway's tracked connections of the stream's engines, as `conntrack -L` prints them. */
function engineFlows(streamId: string): string {
  const ips = engineContainers(streamId).map((name) =>
    docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", name).trim(),
  );
  const flows = compose("exec", "-T", "netgw", "conntrack", "-L");
  const lines = flows.split("\n").filter((line) => ips.some((ip) => ip !== "" && line.includes(`src=${ip} `)));
  return `engines: ${ips.join(", ")}\n${lines.join("\n")}\n`;
}

test("detects infohashes without being told", async ({ page, request }) => {
  // A bare value is tried as a content ID first; the engine rejects it, so it must fall back.
  const bare = await addStream(request, bc[1]!.infohash);
  expect(bare.aceIdKind).toBeNull();
  expect((await waitForPlaying(request, bare.id)).aceIdKind).toBe("infohash");

  // A magnet link says what it is up front.
  const magnet = await addStream(request, `magnet:?xt=urn:btih:${bc[2]!.infohash}&dn=test`);
  expect(magnet.aceIdKind).toBe("infohash");
  await waitForPlaying(request, magnet.id);

  await page.goto("/");
  await page.getByRole("button", { name: "Streams", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Streams" });
  await expect(dialog.locator(".row", { hasText: bare.aceId })).toContainText("infohash");
  await expect(dialog.locator(".row", { hasText: bc[0]!.contentId })).toContainText("content ID");
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
  expect(before).toHaveLength(3);

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

/** One series' value in the controller's metrics text; the registry adds a service label of its own. */
function metricValue(text: string, name: string, labels: string): number | undefined {
  const match = new RegExp(String.raw`^${name}\{${labels}[^}]*\} (\S+)$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

test("disables a stream, says how long ago it had video, and plays it again once enabled", async ({
  page,
  request,
}) => {
  const target = (await snapshot(request)).streams.find((stream) => stream.aceId === bc[1]!.infohash);
  expect(target).toBeDefined();
  const id = target!.id;
  const playing = await waitForPlaying(request, id);
  expect(playing.lastFrameAt).not.toBeNull();
  expect(playing.path).toBe("direct");

  await page.goto("/");
  const streams = page.getByRole("button", { name: "Streams", exact: true });
  await streams.click();
  const row = page.getByRole("dialog", { name: "Streams" }).locator(".row", { hasText: target!.aceId });
  const restart = row.getByRole("button", { name: "Restart" });
  const disable = row.getByRole("button", { name: "Disable" });
  const enable = row.getByRole("button", { name: "Enable" });
  await expect(restart).toBeVisible();
  await expect(enable).toBeHidden();
  // A double press: its second half lands on Enable, which takes Disable's place under the pointer
  // once the controller answers, and must not undo the first. The page presses Enable the moment
  // it is there, which a pointer driven from here could not time.
  await page.evaluate(`(() => {
    const row = [...document.querySelectorAll("dialog[open] .row")].find((item) => item.textContent.includes("${target!.aceId}"));
    const second = [...row.querySelectorAll("button")].find((button) => button.textContent === "Enable");
    new MutationObserver((records, observer) => {
      if (!second.hidden) {
        observer.disconnect();
        second.click();
        row.dataset.secondPress = "sent";
      }
    }).observe(row, { attributes: true, attributeFilter: ["hidden"], subtree: true });
  })()`);
  await disable.click();
  await expect(row).toHaveAttribute("data-second-press", "sent");

  // One Enable button takes the place of Restart and Disable (a disabled stream has nothing to
  // restart), exactly as wide as the two, and the focus of the press goes to it.
  await expect(row.locator(".badge")).toHaveText("Disabled");
  await expect(enable).toBeFocused();
  await expect(restart).toBeHidden();
  await expect(disable).toBeHidden();
  const width = async (selector: string) => (await row.locator(selector).boundingBox())?.width;
  expect(await width(".row-pair > button")).toBe(await width(".row-pair-buttons"));

  // It stopped: on no path, nothing to restart, its engine gone. It still knows its last video.
  const stopped = await streamById(request, id);
  expect(stopped).toMatchObject({ enabled: false, state: "stopped", path: null });
  expect(Date.parse(stopped!.lastFrameAt!)).toBeGreaterThanOrEqual(Date.parse(playing.lastFrameAt!));
  const refused = await request.post(`/api/streams/${id}/restart`);
  expect(refused.status()).toBe(404);
  expect(await refused.json()).toEqual({ error: "stream is disabled" });
  await expect.poll(() => engineContainers(id), { timeout: 30_000 }).toEqual([]);
  // It is no outage in the metrics: the stream is listed and says why, but has no up value, so the
  // alert, the dashboard's outages and its availability leave the time it is off out.
  const off = await (await request.get("/metrics")).text();
  expect(metricValue(off, "aceswarm_stream_state", `stream="${id}",state="stopped"`)).toBe(1);
  expect(metricValue(off, "aceswarm_stream_up", `stream="${id}"`)).toBeUndefined();

  // The tile says so: "Disabled", no path, the age of its last video (not "Never"), no peers.
  await page.goBack();
  const tile = page.locator(`.tile[data-stream="${id}"]`);
  await expect(tile).toHaveAttribute("data-state", "stopped");
  await expect(tile.locator(".badge").first()).toHaveText("Disabled");
  await expect(tile.locator(".badge.path")).toBeHidden();
  await tile.hover();
  const stat = (label: string) => tile.locator(".tile-stats .stat", { hasText: label }).locator(".stat-value");
  await expect(stat("Freshness")).toHaveText(/^\d+[sm] ago$/);
  await expect(stat("Peers")).toHaveText("–");
  await expect(page.locator("#summary")).toContainText("1 disabled");

  // The player says why there is no picture, offers to enable it, and counts nobody as watching.
  await tile.click();
  const player = page.getByRole("dialog", { name: "Player" });
  await expect(player.locator(".player-waiting")).toContainText("This stream is disabled");
  await expect(player.locator(".player-details")).toContainText(/^Disabled\s+·\s+Last frame: \d+[sm] ago$/);
  await expect(player.getByRole("button", { name: "Enable stream" })).toBeVisible();
  expect((await streamById(request, id))?.viewers).toBe(0);
  await page.keyboard.press("Escape");
  await expect(player).toBeHidden();

  // Enabled from the same row, Restart and Disable are back, and it plays again, with new video.
  await streams.click();
  await enable.click();
  await expect(disable).toBeFocused();
  await expect(restart).toBeVisible();
  await expect(enable).toBeHidden();
  await waitForPlaying(request, id);
  await expect
    .poll(async () => Date.parse((await streamById(request, id))?.lastFrameAt ?? ""), { timeout: 30_000 })
    .toBeGreaterThan(Date.parse(stopped!.lastFrameAt!));
  await expect(tile).toHaveAttribute("data-state", "playing");
  await expect(page.locator("#summary")).not.toContainText("disabled");
  await expect
    .poll(async () => metricValue(await (await request.get("/metrics")).text(), "aceswarm_stream_up", `stream="${id}"`))
    .toBe(1);
  expect(engineContainers(id)).toHaveLength(1);
});

test("enabling a stream right after disabling it starts it clean, once its old run is gone", async ({ request }) => {
  const target = (await snapshot(request)).streams.find((stream) => stream.aceId === bc[1]!.infohash);
  expect(target).toBeDefined();
  const id = target!.id;
  await waitForPlaying(request, id);
  // Container ids: a new engine can get the name of the one that was removed.
  const engineIds = () =>
    docker("ps", "--filter", `label=aceswarm.stream=${id}`, "--format", "{{.ID}}")
      .split("\n")
      .filter((containerId) => containerId.length > 0);
  const old = engineIds();
  expect(old).toHaveLength(1);

  // Back to back, as a user bouncing a stream does: the old run's teardown (its pipeline, session
  // and engine) is still going when the stream is enabled again, and the new run waits for it
  // rather than taking over the engine that teardown is about to remove.
  const enabled = async (value: boolean) => {
    const response = await request.patch(`/api/streams/${id}`, { data: { enabled: value } });
    expect(response.ok(), await response.text()).toBe(true);
  };
  await enabled(false);
  await enabled(true);

  // It plays from an engine of its own, and needed no recovery on the way there.
  await waitForPlaying(request, id);
  const now = engineIds();
  expect(now).toHaveLength(1);
  expect(now).not.toContain(old[0]);
  expect((await streamById(request, id))?.recoveries).toBe(0);
});

test("removes a stream from the manage dialog, and its engine", async ({ page, request }) => {
  const target = (await snapshot(request)).streams.find((stream) => stream.aceId === bc[2]!.infohash);
  expect(target).toBeDefined();
  expect(engineContainers(target!.id).length).toBeGreaterThan(0);

  await page.goto("/");
  await page.getByRole("button", { name: "Streams", exact: true }).click();
  const row = page.getByRole("dialog", { name: "Streams" }).locator(".row", { hasText: target!.aceId });
  const remove = row.getByRole("button", { name: "Remove" });
  await remove.click();
  await expect(row.getByRole("button", { name: "Press again to remove" })).toBeVisible();
  await row.getByRole("button", { name: "Press again to remove" }).click();
  await expect(row).toBeHidden();
  await expect.poll(async () => streamById(request, target!.id)).toBeUndefined();
  await expect.poll(() => engineContainers(target!.id), { timeout: 30_000 }).toEqual([]);
});
