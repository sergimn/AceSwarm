import { expect, test } from "@playwright/test";
import { addStream, docker, engineContainers, resetStack, streamById, waitForPlaying } from "./helpers.ts";
import { broadcasts, newestSegment, setBroadcastInput, setDirectPathBlocked, type Broadcast } from "./mesh.ts";

test.describe.configure({ mode: "serial" });

const bc: Broadcast[] = [];

test.beforeAll(async ({ request }) => {
  setDirectPathBlocked(false);
  await resetStack(request);
  bc.push(...(await broadcasts(2)));
});

test.afterAll(async () => {
  setDirectPathBlocked(false);
  if (bc[0] !== undefined) {
    await setBroadcastInput(bc[0], true);
  }
});

test("recovers a stream whose swarm stalls", async ({ request }) => {
  // With the default settings: hot standby is on, but with one path there is nowhere for a standby.
  const settings = await request.patch("/api/settings", { data: { hotStandby: true } });
  expect(settings.ok(), await settings.text()).toBe(true);
  // Without a WireGuard profile the direct path is the only one, so cutting the broadcast runner
  // off at this runner's firewall is a swarm that dries up: no path can help.
  const stream = await addStream(request, bc[0]!.infohash, "Flaky");
  const before = await waitForPlaying(request, stream.id);
  expect(before.standbys).toEqual([]);
  setDirectPathBlocked(true);
  try {
    await expect
      .poll(async () => (await streamById(request, stream.id))?.recoveries, { timeout: 180_000, intervals: [1000] })
      .toBeGreaterThan(before.recoveries);
    expect((await streamById(request, stream.id))?.state).not.toBe("playing");
  } finally {
    setDirectPathBlocked(false);
  }

  // Recovery keeps trying, so the stream plays again once the swarm is back.
  const playing = await waitForPlaying(request, stream.id, 240_000);
  expect(playing.path).toBe("direct");
  expect(playing.standbys).toEqual([]);
  expect(engineContainers(stream.id)).toHaveLength(1);
});

test("restarting one engine leaves the other streams alone", async ({ request }) => {
  await resetStack(request);
  const victim = await addStream(request, bc[0]!.contentId, "Victim");
  const bystander = await addStream(request, bc[1]!.infohash, "Bystander");
  await waitForPlaying(request, victim.id);
  const before = await waitForPlaying(request, bystander.id);

  const [engine] = engineContainers(victim.id);
  expect(engine).toBeDefined();
  docker("restart", "--time", "1", engine!);

  // The bystander keeps receiving new frames while the victim recovers.
  for (let check = 0; check < 10; check += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await streamById(request, bystander.id);
    expect(current?.state).toBe("playing");
    expect(current?.recoveries).toBe(before.recoveries);
  }
  await waitForPlaying(request, victim.id);
  const after = await streamById(request, bystander.id);
  expect(Date.parse(after!.lastFrameAt!)).toBeGreaterThan(Date.parse(before.lastFrameAt!));
});

test("waits for a broadcast that stops, never plays its old window, and plays it again once it is back", async ({
  request,
}) => {
  await resetStack(request);
  const stream = await addStream(request, bc[0]!.infohash, "Paused");
  await waitForPlaying(request, stream.id);
  await expect
    .poll(async () => (await streamById(request, stream.id))?.liveEdge?.state, { timeout: 30_000 })
    .toBe("live");
  const playlist = stream.hls.full;

  // The source engine keeps running with the window it has, and so does the stream's engine:
  // data still comes for each new session, but the live edge stops (STALE_SOURCE_SECONDS: 30).
  await setBroadcastInput(bc[0]!, false);
  try {
    await expect
      .poll(async () => (await streamById(request, stream.id))?.state, { timeout: 120_000, intervals: [1000] })
      .toBe("stale-source");
    // Nothing older than the threshold stays published: no playlist, no thumbnail.
    await expect.poll(async () => (await request.get(playlist)).status(), { timeout: 45_000 }).toBe(404);
    const waiting = await streamById(request, stream.id);
    expect(waiting?.liveEdge?.state).toBe("stale");
    expect(waiting?.message).toContain("no new data from the broadcast");

    // While it waits, new sessions bring the old window: none of it is published, and it doesn't
    // restart on every stall (a new session every 10 s here, STALE_SOURCE_RETRY_SECONDS).
    for (let check = 0; check < 30; check += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const current = await streamById(request, stream.id);
      expect(current?.state).toBe("stale-source");
      const lastFrameAt = current?.lastFrameAt ?? null;
      expect(lastFrameAt === null || Date.parse(lastFrameAt) < Date.now() - 30_000).toBe(true);
      expect((await request.get(playlist)).status()).toBe(404);
      expect((await request.get(stream.hls.thumbnail)).status()).toBe(404);
    }
    const tries = (await streamById(request, stream.id))!.recoveries - waiting!.recoveries;
    expect(tries).toBeGreaterThanOrEqual(1);
    expect(tries).toBeLessThanOrEqual(4);
  } finally {
    await setBroadcastInput(bc[0]!, true);
  }

  // The next new session gets new data: it plays again, from video that is new.
  const back = await waitForPlaying(request, stream.id, 120_000);
  const resumedAt = Date.now();
  expect(back.liveEdge?.state).toBe("live");
  expect(Date.parse(back.liveEdge!.advancedAt!)).toBeGreaterThan(resumedAt - 15_000);
  expect((await newestSegment(request, playlist))[0]).toBe(0x47);
  expect(engineContainers(stream.id)).toHaveLength(1);
});
