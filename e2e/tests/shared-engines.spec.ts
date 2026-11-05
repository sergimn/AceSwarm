import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { StreamView } from "../../packages/shared/src/api-types.ts";
import {
  addStream,
  engineContainers,
  resetStack,
  sharedEngineContainers,
  snapshot,
  streamById,
  waitForPlaying,
} from "./helpers.ts";
import { broadcasts, setBroadcastBlocked, setDirectPathBlocked, type Broadcast } from "./mesh.ts";

/**
 * One engine per path: two streams on the direct path share one engine. A failing stream leaves
 * it alone, the watched stream failing replaces it, and the other stream keeps its picture
 * throughout. See e2e/README.md.
 */
test.describe.configure({ mode: "serial" });

const bc: Broadcast[] = [];
/** Filled in by the first test; the tests share these two streams. */
const run = { watched: "", bystander: "" };

test.beforeAll(async ({ request }) => {
  setDirectPathBlocked(false);
  await resetStack(request);
  bc.push(...(await broadcasts(2)));
});

test.afterAll(async ({ request }) => {
  for (const broadcast of bc) {
    setBroadcastBlocked(broadcast, false);
  }
  await request.patch("/api/settings", { data: { sharedEngines: false } });
});

async function stream(request: APIRequestContext, id: string): Promise<StreamView> {
  const view = await streamById(request, id);
  if (view === undefined) {
    throw new Error(`stream ${id} disappeared`);
  }
  return view;
}

/** The engine a stream plays from, by name ("" while it has none). */
async function engineOf(request: APIRequestContext, id: string): Promise<string> {
  return (await streamById(request, id))?.engine?.name ?? "";
}

/**
 * Polls until `done` holds, checking all the while that the bystander keeps playing: it must
 * never stall, recover or lose its picture.
 */
async function whileBystanderPlays(
  request: APIRequestContext,
  done: () => Promise<boolean>,
  timeout: number,
): Promise<void> {
  const before = await stream(request, run.bystander);
  const deadline = Date.now() + timeout;
  while (!(await done())) {
    expect(Date.now(), "timed out").toBeLessThan(deadline);
    const bystander = await stream(request, run.bystander);
    expect(bystander.state, bystander.message ?? "").toBe("playing");
    expect(bystander.recoveries).toBe(before.recoveries);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** Opens the first stream in the full screen player, as a viewer would. */
async function watch(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".tile", { hasText: "Watched" }).click();
  await expect(page.getByRole("dialog", { name: "Player" })).toBeVisible();
}

async function metrics(request: APIRequestContext): Promise<string> {
  const response = await request.get("/metrics");
  expect(response.ok()).toBe(true);
  return await response.text();
}

test("turning it on in the Streams dialog moves playing streams onto one engine", async ({ page, request }) => {
  const watched = await addStream(request, bc[0]!.infohash, "Watched");
  const bystander = await addStream(request, bc[1]!.infohash, "Bystander");
  run.watched = watched.id;
  run.bystander = bystander.id;
  await waitForPlaying(request, watched.id);
  const before = await waitForPlaying(request, bystander.id);
  expect(before.engine?.shared).toBe(false);
  expect(engineContainers(watched.id)).toHaveLength(1);

  await page.goto("/");
  await page.getByRole("button", { name: "Streams", exact: true }).click();
  const toggle = page.getByRole("dialog", { name: "Streams" }).getByRole("switch", { name: "One engine per path" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect((await snapshot(request)).sharedEngines.enabled).toBe(true);

  // Each stream moves make-before-break: the bystander never stops playing, and the moves aren't
  // recoveries.
  await whileBystanderPlays(
    request,
    async () => {
      const streams = await Promise.all([stream(request, watched.id), stream(request, bystander.id)]);
      return streams.every((view) => view.engine?.shared === true);
    },
    240_000,
  );
  const [engine] = sharedEngineContainers();
  expect(sharedEngineContainers()).toEqual([engine]);
  expect(await engineOf(request, watched.id)).toBe(engine);
  expect(await engineOf(request, bystander.id)).toBe(engine);
  // Their own engines are gone.
  await expect.poll(() => [...engineContainers(watched.id), ...engineContainers(bystander.id)]).toEqual([]);
  await waitForPlaying(request, watched.id);
});

test("one stream failing restarts only its own session, not the shared engine", async ({ request }) => {
  // Three recovery steps of about a startup grace each, then playing again.
  test.setTimeout(600_000);
  const engine = await engineOf(request, run.watched);
  const before = await stream(request, run.watched);
  // Cut the watched stream's broadcast off while nobody watches it: it is a stream like any other.
  setBroadcastBlocked(bc[0]!, true);
  try {
    await whileBystanderPlays(
      request,
      async () => (await stream(request, run.watched)).recoveries >= before.recoveries + 3,
      240_000,
    );
    // Three steps of its ladder, the third of which would restart its own engine.
    expect(sharedEngineContainers()).toEqual([engine]);
    expect(await engineOf(request, run.bystander)).toBe(engine);
    expect(await metrics(request)).not.toContain("aceswarm_shared_engine_restarts_total{");
  } finally {
    setBroadcastBlocked(bc[0]!, false);
  }
  await waitForPlaying(request, run.watched, 240_000);
  expect(await engineOf(request, run.watched)).toBe(engine);
});

test("counts the player as a viewer, with a throwaway id", async ({ page, request }) => {
  await watch(page);
  await expect.poll(async () => (await stream(request, run.watched)).viewers).toBe(1);
  expect((await stream(request, run.bystander)).viewers).toBe(0);
  const viewers = (await (await request.get("/api/viewers")).json()) as { viewer: string; stream: string }[];
  expect(viewers).toHaveLength(1);
  expect(viewers[0]?.stream).toBe(run.watched);
  expect(viewers[0]?.viewer).toMatch(/^[0-9a-f]{16}$/);
  expect(await metrics(request)).toMatch(
    new RegExp(
      String.raw`aceswarm_viewer_watching\{viewer="${viewers[0]!.viewer}",device="[^"]+",stream="${run.watched}"\} 1`,
    ),
  );
  // Nothing is stored in the browser: a new visit is a new viewer.
  expect(await page.context().cookies()).toEqual([]);
  expect(await page.evaluate<number>("localStorage.length + sessionStorage.length")).toBe(0);
  await page.reload();
  await page.locator(".tile", { hasText: "Watched" }).click();
  const ids = async () =>
    ((await (await request.get("/api/viewers")).json()) as { viewer: string }[]).map(({ viewer }) => viewer);
  await expect.poll(ids).toHaveLength(1);
  expect(await ids()).not.toContain(viewers[0]!.viewer);

  // Closing the player stops counting the viewer right away.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Player" })).toBeHidden();
  await expect.poll(async () => (await stream(request, run.watched)).viewers).toBe(0);
});

test("the watched stream failing replaces the engine, and the other stream keeps its picture", async ({
  page,
  request,
}) => {
  await watch(page);
  await expect.poll(async () => (await stream(request, run.watched)).viewers).toBe(1);
  const engine = await engineOf(request, run.watched);

  setBroadcastBlocked(bc[0]!, true);
  try {
    // Its first recovery step replaces the engine: a second one starts on the same path.
    await whileBystanderPlays(request, () => Promise.resolve(sharedEngineContainers().length === 2), 180_000);
  } finally {
    // The swarm comes back, so the watched stream plays again on the new engine.
    setBroadcastBlocked(bc[0]!, false);
  }
  // Both streams move to it, and the old one goes.
  await whileBystanderPlays(
    request,
    async () => {
      const engines = await Promise.all([engineOf(request, run.watched), engineOf(request, run.bystander)]);
      const containers = sharedEngineContainers();
      return containers.length === 1 && engines.every((name) => name === containers[0] && name !== engine);
    },
    300_000,
  );
  expect(await metrics(request)).toMatch(/aceswarm_shared_engine_restarts_total\{path="direct",reason="watched"\} 1/);
  await waitForPlaying(request, run.watched, 240_000);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await stream(request, run.watched)).viewers).toBe(0);
});

test("turning it off moves each stream to an engine of its own", async ({ request }) => {
  const response = await request.patch("/api/settings", { data: { sharedEngines: false } });
  expect(response.ok()).toBe(true);
  await whileBystanderPlays(
    request,
    () => Promise.resolve(engineContainers(run.watched).length === 1 && engineContainers(run.bystander).length === 1),
    240_000,
  );
  await expect.poll(() => sharedEngineContainers(), { timeout: 120_000 }).toEqual([]);
  for (const id of [run.watched, run.bystander]) {
    const view = await waitForPlaying(request, id);
    expect(view.engine).toEqual({ name: engineContainers(id)[0], shared: false });
  }
});
