import { existsSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  addStream,
  composeAsync,
  engineContainers,
  resetStack,
  sharedEngineContainers,
  streamById,
  waitForPlaying,
  waitForSteadyPlaying,
} from "./helpers.ts";
import { broadcasts, remoteWireguardProfile, setDirectPathBlocked, type Broadcast } from "./mesh.ts";

/**
 * Restarting the controller (an update, say) must not interrupt playing streams: the new run takes
 * over the engine session and the transcoder's ffmpeg that kept running, the old one stops within
 * a few seconds even with the UI open, and the player rides out the moment the controller (which
 * proxies the HLS) is gone. A hot standby isn't taken over: the new run starts a new one. See
 * e2e/README.md.
 */
test.describe.configure({ mode: "serial" });

// Chromium builds can't decode H.264, so the browser part needs Google Chrome. GitHub's runners
// have it; elsewhere set PW_CHANNEL=chrome, or the test checks only the server side.
const chrome = process.env["PW_CHANNEL"] === undefined && existsSync("/opt/google/chrome/chrome");
test.use(chrome ? { channel: "chrome" } : {});

/** Longest the controller may be unreachable: the player buffers about three 2 s segments. */
const MAX_OUTAGE_MS = 4000;
/** Docker and Podman kill a container that hasn't stopped 10 s after SIGTERM. */
const MAX_STOP_MS = 5000;

/** The VPN profile the hot standby case adds, and removes again. */
const PROFILE = "ci-restart";
const VPN_PATH = `wg:${PROFILE}`;

const bc: Broadcast[] = [];
/** The first case's stream, which the hot standby case plays on. */
const run = { ownId: "" };

test.beforeAll(async ({ request }) => {
  setDirectPathBlocked(false);
  await resetStack(request);
  bc.push(...(await broadcasts(2)));
});

test.afterAll(async ({ request }) => {
  await request.patch("/api/settings", { data: { sharedEngines: false, hotStandby: false } });
  await request.delete(`/api/wireguard/${PROFILE}`);
});

interface PlaylistSample {
  at: number;
  ok: boolean;
  /** The ffmpeg run ("generation") of the newest segment, and its number. */
  generation?: number;
  segment?: number;
}

/** The generation and number of the newest segment in an HLS media playlist. */
function newestOf(playlist: string): { generation: number; segment: number } | undefined {
  const uris = playlist.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
  const match = /g(\d+)\/full\/seg_(\d+)\.ts$/.exec(uris.at(-1) ?? "");
  return match === null ? undefined : { generation: Number(match[1]), segment: Number(match[2]) };
}

/** Polls the stream's playlist through the controller, as a player does, until stopped. */
function watchPlaylist(baseUrl: string, id: string): { stop: () => Promise<PlaylistSample[]> } {
  const samples: PlaylistSample[] = [];
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      const at = Date.now();
      try {
        const response = await fetch(`${baseUrl}/hls/${id}/full/index.m3u8`, { signal: AbortSignal.timeout(1000) });
        const newest = response.ok ? newestOf(await response.text()) : undefined;
        samples.push({ at, ok: newest !== undefined, ...newest });
      } catch {
        samples.push({ at, ok: false });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  return {
    stop: async () => {
      state.running = false;
      await loop;
      return samples;
    },
  };
}

/** The longest stretch of failed samples, in ms. */
function longestOutage(samples: PlaylistSample[]): number {
  let longest = 0;
  let since: number | undefined;
  for (const sample of samples) {
    if (!sample.ok) {
      since ??= sample.at;
    } else if (since !== undefined) {
      longest = Math.max(longest, sample.at - since);
      since = undefined;
    }
  }
  return since === undefined ? longest : Math.max(longest, Date.now() - since);
}

/** The longest time between two new segments showing up, in ms. */
function longestWithoutNewSegment(samples: PlaylistSample[]): number {
  let longest = 0;
  let last: { at: number; segment: number } | undefined;
  for (const sample of samples) {
    if (sample.segment === undefined) {
      continue;
    }
    if (sample.segment !== last?.segment) {
      if (last !== undefined) {
        longest = Math.max(longest, sample.at - last.at);
      }
      last = { at: sample.at, segment: sample.segment };
    }
  }
  return longest;
}

/** Opens the stream full screen and, when the browser decodes H.264, records the video's progress. */
async function openPlayer(page: Page, name: string): Promise<boolean> {
  await page.goto("/");
  await page.locator(".tile", { hasText: name }).click();
  await expect(page.getByRole("dialog", { name: "Player" })).toBeVisible();
  const canPlay = await page.evaluate<boolean>(
    `MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028,mp4a.40.2"')`,
  );
  if (!canPlay) {
    // CI's runners have Google Chrome: there, the video check must not go missing without notice.
    expect(process.env["CI"], "the browser can't play H.264, so the video can't be checked").toBeUndefined();
    return false;
  }
  await expect
    .poll(() => page.evaluate<number>(`document.querySelector(".player video").currentTime`), { timeout: 60_000 })
    .toBeGreaterThan(2);
  // The specs run in Node without DOM types, so browser-side code is passed as a string.
  await page.evaluate(`(() => {
    const video = document.querySelector(".player video");
    const progress = { longestStallMs: 0, waiting: 0, last: video.currentTime, since: performance.now() };
    window.__progress = progress;
    video.addEventListener("waiting", () => { progress.waiting += 1; });
    setInterval(() => {
      const now = performance.now();
      if (video.currentTime !== progress.last) {
        progress.last = video.currentTime;
        progress.since = now;
      }
      progress.longestStallMs = Math.max(progress.longestStallMs, now - progress.since);
    }, 100);
  })()`);
  return true;
}

interface RestartResult {
  stopMs: number;
  outageMs: number;
  noNewSegmentMs: number;
  generations: number[];
}

/**
 * Stops and starts the controller while polling the stream's playlist, then lets it play on. The
 * page, if any, keeps the UI's event stream open, which closing the server used to wait for. The
 * compose commands don't block, so the polling goes on while they run: the outage counts from the
 * moment the old controller stops answering.
 */
async function restartController(request: APIRequestContext, baseUrl: string, id: string): Promise<RestartResult> {
  const watcher = watchPlaylist(baseUrl, id);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const stopping = Date.now();
  await composeAsync("stop", "controller");
  const stopMs = Date.now() - stopping;
  await composeAsync("start", "controller");
  await expect
    .poll(async () => (await request.get("/healthz").catch(() => undefined))?.ok(), {
      timeout: 60_000,
      intervals: [100],
    })
    .toBe(true);
  // The new run takes the stream over on its first check.
  await expect.poll(async () => (await streamById(request, id))?.state, { timeout: 15_000 }).toBe("playing");
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const samples = await watcher.stop();
  const generations = [...new Set(samples.flatMap((sample) => sample.generation ?? []))];
  return {
    stopMs,
    outageMs: longestOutage(samples),
    noNewSegmentMs: longestWithoutNewSegment(samples),
    generations,
  };
}

function report(label: string, result: RestartResult, stallMs?: number): void {
  const parts = [
    `stop ${String(result.stopMs)} ms`,
    `controller unreachable ${String(result.outageMs)} ms`,
    `longest without a new segment ${String(result.noNewSegmentMs)} ms`,
    `ffmpeg runs ${result.generations.join(",")}`,
    ...(stallMs === undefined ? [] : [`longest video stall ${String(Math.round(stallMs))} ms`]),
  ];
  const description = `${label}: ${parts.join("; ")}`;
  test.info().annotations.push({ type: "controller restart", description });
  // In the CI log too.
  process.stdout.write(`${description}\n`);
}

test("a controller restart doesn't interrupt a stream on its own engine", async ({ page, request, baseURL }) => {
  const stream = await addStream(request, bc[0]!.infohash, "Restart own");
  run.ownId = stream.id;
  await waitForSteadyPlaying(request, stream.id);
  const engines = engineContainers(stream.id);
  expect(engines).toHaveLength(1);

  const playing = await openPlayer(page, "Restart own");
  const result = await restartController(request, baseURL!, stream.id);
  const progress = playing
    ? await page.evaluate<{ longestStallMs: number; waiting: number }>("window.__progress")
    : undefined;
  report("own engine", result, progress?.longestStallMs);

  // The same engine and the same ffmpeg run: nothing restarted.
  expect(engineContainers(stream.id)).toEqual(engines);
  expect(result.generations).toHaveLength(1);
  expect(result.stopMs).toBeLessThan(MAX_STOP_MS);
  expect(result.outageMs).toBeLessThan(MAX_OUTAGE_MS);
  if (progress !== undefined) {
    // The picture never froze: the player played on from its buffer.
    expect(progress.longestStallMs).toBeLessThan(1500);
  }
  expect((await streamById(request, stream.id))?.recoveries).toBe(0);
});

test("a controller restart doesn't interrupt a stream that has a hot standby, and starts a new standby", async ({
  request,
  baseURL,
}) => {
  const settings = await request.patch("/api/settings", { data: { hotStandby: true } });
  expect(settings.ok(), await settings.text()).toBe(true);
  const profile = await request.post("/api/wireguard", {
    data: { name: PROFILE, config: await remoteWireguardProfile() },
  });
  expect(profile.ok(), await profile.text()).toBe(true);
  /** The stream's standbys, as "<path> <state>". */
  const standbys = async (): Promise<string> =>
    ((await streamById(request, run.ownId))?.standbys ?? []).map(({ path, state }) => `${path} ${state}`).join(", ");
  await expect.poll(standbys, { timeout: 240_000, intervals: [2000] }).toBe(`${VPN_PATH} hot`);
  const before = await waitForSteadyPlaying(request, run.ownId);
  const playsFrom = before.engine?.name;
  const standby = before.standbys[0]?.engine?.name;
  expect(playsFrom).toBeTruthy();
  expect(standby).toBeTruthy();
  expect(engineContainers(run.ownId)).toHaveLength(2);

  const result = await restartController(request, baseURL!, run.ownId);
  report("own engine with a hot standby", result);

  // The engine it plays from and its ffmpeg run went on, on the same path.
  expect(await streamById(request, run.ownId)).toMatchObject({
    path: "direct",
    engine: { name: playsFrom },
    recoveries: 0,
  });
  expect(result.generations).toHaveLength(1);
  expect(result.outageMs).toBeLessThan(MAX_OUTAGE_MS);
  // The standby isn't taken over: the new run removes its engine and starts a new one.
  await expect.poll(standbys, { timeout: 240_000, intervals: [2000] }).toBe(`${VPN_PATH} hot`);
  const engines = engineContainers(run.ownId);
  expect(engines).toHaveLength(2);
  expect(engines).toContain(playsFrom);
  expect(engines).not.toContain(standby);

  // The next case starts from one engine and one path.
  const off = await request.patch("/api/settings", { data: { hotStandby: false } });
  expect(off.ok(), await off.text()).toBe(true);
  const removed = await request.delete(`/api/wireguard/${PROFILE}`);
  expect(removed.ok(), await removed.text()).toBe(true);
  await expect.poll(() => engineContainers(run.ownId), { timeout: 60_000 }).toEqual([playsFrom]);
});

test("a controller restart doesn't interrupt a stream on a shared engine", async ({ request, baseURL }) => {
  const settings = await request.patch("/api/settings", { data: { sharedEngines: true } });
  expect(settings.ok(), await settings.text()).toBe(true);
  const stream = await addStream(request, bc[1]!.infohash, "Restart shared");
  await waitForPlaying(request, stream.id);
  // Every stream moves to the path's shared engine.
  await expect.poll(() => sharedEngineContainers(), { timeout: 240_000 }).toHaveLength(1);
  await expect
    .poll(async () => (await streamById(request, stream.id))?.engine?.shared, { timeout: 240_000 })
    .toBe(true);
  await waitForSteadyPlaying(request, stream.id);
  const shared = sharedEngineContainers();

  const result = await restartController(request, baseURL!, stream.id);
  report("shared engine", result);

  expect(sharedEngineContainers()).toEqual(shared);
  expect(result.generations).toHaveLength(1);
  expect(result.outageMs).toBeLessThan(MAX_OUTAGE_MS);
  expect((await streamById(request, stream.id))?.engine).toMatchObject({ shared: true });
});
