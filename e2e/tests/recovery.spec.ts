import { expect, test } from "@playwright/test";
import { addStream, docker, engineContainers, resetStack, streamById, waitForPlaying } from "./helpers.ts";
import { broadcasts, setDirectPathBlocked, type Broadcast } from "./mesh.ts";

test.describe.configure({ mode: "serial" });

const bc: Broadcast[] = [];

test.beforeAll(async ({ request }) => {
  setDirectPathBlocked(false);
  await resetStack(request);
  bc.push(...(await broadcasts(2)));
});

test.afterAll(() => {
  setDirectPathBlocked(false);
});

test("recovers a stream whose swarm stalls", async ({ request }) => {
  // Without a WireGuard profile the direct path is the only one, so cutting the broadcast runner
  // off at this runner's firewall is a swarm that dries up: no path can help.
  const stream = await addStream(request, bc[0]!.infohash, "Flaky");
  const before = await waitForPlaying(request, stream.id);
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
