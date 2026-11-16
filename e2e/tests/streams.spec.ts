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
  await expect(stats.locator(".stat", { hasText: "Download" })).toContainText(/KiB\/s|MiB\/s/);

  // A bare value (acestream:// links carry one) is tried as a content ID first, which works here.
  const stream = (await snapshot(request)).streams.find((candidate) => candidate.aceId === contentId);
  expect(stream?.aceIdKind).toBe("content-id");
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
  // Two streams are a list: the dialog says where a list goes, and adds neither.
  await dialog.getByLabel("Acestream ID or infohash").fill(`${"1".repeat(40)}, ${"2".repeat(40)}`);
  await dialog.getByRole("button", { name: "Add stream" }).click();
  await expect(dialog.getByRole("alert")).toContainText('Turn on "Add several at once"');
  await expect(page.locator(".tile")).toHaveCount(3);
});

test("adds a pasted list with the remote: wrong lines stay to correct, known streams are skipped", async ({
  page,
  request,
}) => {
  // Two streams nobody broadcasts. They are added disabled, so no engine starts for them.
  const fresh = ["1".repeat(40), "2".repeat(40)];
  await page.goto("/");
  // Once the page has its streams it has also moved the focus to the first tile, as it does when
  // it opens: from here on the focus is the test's.
  await expect(page.locator(".tile")).toHaveCount(3);
  const add = page.getByRole("button", { name: "Add", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Add stream" });
  const single = dialog.getByLabel("Acestream ID or infohash");
  await expect(single).toBeFocused();

  // Up from the field is the switch. It swaps the fields for one stream for a box for a list.
  await page.keyboard.press("ArrowUp");
  const several = dialog.getByRole("switch", { name: "Add several at once" });
  await expect(several).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(several).toHaveAttribute("aria-checked", "true");
  await expect(single).toBeHidden();
  await expect(dialog.getByLabel("Name")).toBeHidden();
  await page.keyboard.press("ArrowDown");
  const list = dialog.getByLabel("Acestream IDs or infohashes");
  await expect(list).toBeFocused();
  await page.keyboard.insertText(
    [
      `"acestream://${fresh[0]!}",`,
      // In the list since the first test, as "Test pattern".
      `Known - ${bc[0]!.contentId.toUpperCase()}`,
      "not a stream",
      `magnet:?xt=urn:btih:${fresh[1]!}&dn=x`,
      fresh[0]!,
    ].join("\n"),
  );
  // The dialog says what the list holds before anything is sent.
  await expect(dialog.locator("#add-list-summary")).toHaveText(
    "3 streams found. No Acestream ID or infohash on line 3. 1 line repeats a stream above.",
  );

  // The caret is at the end of the box, so Down leaves it: to the start switch, then to Add.
  await page.keyboard.press("ArrowDown");
  const start = dialog.getByRole("switch", { name: "Start them right away" });
  await expect(start).toBeFocused();
  await expect(start).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(start).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("button", { name: "Add 3 streams" })).toBeFocused();
  await page.keyboard.press("Enter");

  // One line is no stream, so the dialog stays, says what became of each kind of line, and keeps
  // only that line in the box. What it says has the focus: a remote scrolls by moving it.
  const result = dialog.locator(".form-result");
  await expect(result).toBeFocused();
  await expect(result.locator("p")).toHaveText([
    "Added 2 streams, disabled.",
    "1 was already in the list: Test pattern.",
    "1 line repeats a stream above.",
    "1 line has no Acestream ID or infohash. It is still in the box, to correct or remove.",
  ]);
  await expect(list).toHaveValue("not a stream");
  await expect(dialog.locator("#add-list-summary")).toHaveText(
    "0 streams found. No Acestream ID or infohash on line 1.",
  );

  // The two new streams are there, disabled and without an engine; the known one is as it was.
  const { streams } = await snapshot(request);
  expect(streams).toHaveLength(5);
  const added = streams.filter((stream) => fresh.includes(stream.aceId));
  expect(added.map(({ aceId, aceIdKind, enabled, state }) => ({ aceId, aceIdKind, enabled, state }))).toEqual([
    { aceId: fresh[0], aceIdKind: null, enabled: false, state: "stopped" },
    { aceId: fresh[1], aceIdKind: "infohash", enabled: false, state: "stopped" },
  ]);
  for (const stream of added) {
    expect(engineContainers(stream.id)).toEqual([]);
  }
  expect(streams.find((stream) => stream.aceId === bc[0]!.contentId)).toMatchObject({ name: "Test pattern" });

  // Sent again, the line that is left adds nothing: the dialog says so and stays. On the way to
  // Add is the button that closes the dialog, which says Done now that streams were added.
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("button", { name: "Done" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("button", { name: "Add streams" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("No line of the list has an Acestream ID or infohash.");
  await expect(dialog.getByRole("button", { name: "Done" })).toBeVisible();

  // Back closes the dialog, and the new tiles are in the grid.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
  await expect(page.locator(".tile")).toHaveCount(5);
  for (const stream of added) {
    await expect(page.locator(`.tile[data-stream="${stream.id}"] .badge`).first()).toHaveText("Disabled");
  }

  // A list pasted into the field for one stream is a list too: the dialog turns into the one for
  // a list. The page pastes it, as the clipboard of a browser under test can't be relied on.
  await add.click();
  await expect(several).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  const pasted = `${fresh[0]!}\n${fresh[1]!}\n`;
  await page.evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text", ${JSON.stringify(pasted)});
    const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector("dialog[open] input[name=aceId]").dispatchEvent(paste);
  })()`);
  await expect(several).toHaveAttribute("aria-checked", "true");
  await expect(list).toBeFocused();
  await expect(list).toHaveValue(pasted);
  // Both are in the list by now: nothing is added, and nothing is left in the box to correct.
  await dialog.getByRole("button", { name: "Add 2 streams" }).click();
  await expect(result.locator("p")).toHaveText([
    "No stream was added.",
    `2 were already in the list: Stream ${fresh[0]!.slice(0, 6)} and Stream ${fresh[1]!.slice(0, 6)}.`,
  ]);
  await expect(list).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The tests after this one find the three streams of the tests before it.
  for (const stream of added) {
    expect((await request.delete(`/api/streams/${stream.id}`)).status()).toBe(204);
  }
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
  // Every change of the stream the page asks for, to tell that the double press below sent one.
  const patches: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === `/api/streams/${id}`) {
      patches.push(request.postData() ?? "");
    }
  });
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
  // Only the first half asked for anything: the row ignores a press that lands as its buttons swap.
  expect(patches, "the second half of the double press changed the stream too").toEqual(['{"enabled":false}']);

  // One Enable button takes the place of Restart and Disable (a disabled stream has nothing to
  // restart), exactly as wide as the two, and the focus of the press goes to it.
  await expect(row.locator(".badge")).toHaveText("Disabled");
  await expect(enable).toBeFocused();
  // Nothing followed late either.
  expect(patches).toEqual(['{"enabled":false}']);
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
