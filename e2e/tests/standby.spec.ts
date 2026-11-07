import { expect, test, type APIRequestContext } from "@playwright/test";
import type { StreamState, StreamView } from "../../packages/shared/src/api-types.ts";
import {
  addStream,
  docker,
  engineContainers,
  gatewayAssignments,
  resetStack,
  sharedEngineContainers,
  snapshot,
  streamById,
  waitForPlaying,
  waitForSteadyPlaying,
} from "./helpers.ts";
import { broadcasts, remoteWireguardProfile } from "./mesh.ts";

/**
 * Hot standby: a stream on the direct path keeps a standby on the VPN that already pulls the
 * broadcast, so when the engine it plays from fails it moves to the standby within seconds,
 * without starting an engine or going through the recovery ladder. See e2e/README.md.
 *
 * The engine fails by being paused: it stops answering, as one that hangs. Cutting the direct path
 * off would not stall the stream here: its engine keeps getting the broadcast from the standby,
 * over the engines' network.
 */
test.describe.configure({ mode: "serial" });

const PROFILE = "ci-standby";
const VPN_PATH = `wg:${PROFILE}`;
/** A failover takes seconds; the ladder would take minutes to move the stream. */
const FAILOVER_TIMEOUT_MS = 120_000;
/** Filled in by the first test; the tests share one stream. */
const run = { streamId: "", paused: [] as string[] };

async function patchSettings(request: APIRequestContext, data: Record<string, boolean>): Promise<void> {
  const response = await request.patch("/api/settings", { data });
  expect(response.ok(), await response.text()).toBe(true);
}

async function stream(request: APIRequestContext): Promise<StreamView> {
  const view = await streamById(request, run.streamId);
  if (view === undefined) {
    throw new Error(`stream ${run.streamId} disappeared`);
  }
  return view;
}

/** The stream's standbys, as "<path> <state>". */
async function standbys(request: APIRequestContext): Promise<string[]> {
  return (await stream(request)).standbys.map(({ path, state }) => `${path} ${state}`);
}

/** Pauses an engine container, so it stops answering like an engine that hangs. */
function pauseEngine(name: string): void {
  docker("pause", name);
  run.paused.push(name);
}

function unpauseEngines(): void {
  for (const name of run.paused.splice(0)) {
    try {
      docker("unpause", name);
    } catch {
      // The controller removed it meanwhile.
    }
  }
}

/** Polls until the stream plays on `path`, and returns every state it showed meanwhile. */
async function statesUntilOn(request: APIRequestContext, path: string): Promise<Set<StreamState>> {
  const states = new Set<StreamState>();
  const deadline = Date.now() + FAILOVER_TIMEOUT_MS;
  for (;;) {
    const view = await stream(request);
    states.add(view.state);
    if (view.path === path && view.state === "playing") {
      return states;
    }
    expect(Date.now(), `stream never played on ${path}; states: ${[...states].join(", ")}`).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.beforeAll(async ({ request }) => {
  await resetStack(request);
  await patchSettings(request, { hotStandby: true });
});

test.afterAll(async ({ request }) => {
  unpauseEngines();
  await request.patch("/api/settings", { data: { hotStandby: false, sharedEngines: false } });
});

test("keeps a hot standby on the VPN once the stream plays", async ({ request }) => {
  const [broadcast] = await broadcasts(1);
  run.streamId = (await addStream(request, broadcast!.infohash, "Standby")).id;
  const playing = await waitForPlaying(request, run.streamId);
  expect(playing.path).toBe("direct");
  // With one path, there is nowhere for a standby.
  expect(playing.standbys).toEqual([]);

  const response = await request.post("/api/wireguard", {
    data: { name: PROFILE, config: await remoteWireguardProfile() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await expect
    .poll(async () => (await standbys(request)).join(", "), { timeout: 240_000, intervals: [2000] })
    .toBe(`${VPN_PATH} hot`);
  // An engine of its own on the VPN, routed through the tunnel.
  expect(engineContainers(run.streamId)).toHaveLength(2);
  expect(gatewayAssignments().map(({ path }) => path)).toContain(VPN_PATH);
  expect((await stream(request)).path).toBe("direct");
});

test("fails over to the standby within seconds when the engine it plays from stops answering", async ({ request }) => {
  const before = await waitForSteadyPlaying(request, run.streamId);
  const standbyEngine = before.standbys[0]?.engine?.name;
  expect(standbyEngine).toBeTruthy();
  expect(before.engine?.name).toBeTruthy();
  const engines = engineContainers(run.streamId).toSorted((a, b) => a.localeCompare(b, "en"));

  pauseEngine(before.engine!.name);
  const pausedAt = Date.now();
  let states: Set<StreamState>;
  try {
    states = await statesUntilOn(request, VPN_PATH);
  } finally {
    unpauseEngines();
  }
  const tookSeconds = Math.round((Date.now() - pausedAt) / 1000);
  const description = `on the standby ${String(tookSeconds)}s after its engine stopped answering`;
  test.info().annotations.push({ type: "failover", description });

  // A failover, not the ladder: it never restarted anything, and took seconds, where the ladder
  // takes minutes to move a stream.
  expect(states.has("recovering")).toBe(false);
  expect(tookSeconds).toBeLessThan(60);
  const after = await stream(request);
  expect(after.engine?.name).toBe(standbyEngine);
  expect(after.recoveries).toBe(before.recoveries + 1);
  // No engine started: the one it left becomes the standby on the direct path.
  expect(engineContainers(run.streamId).toSorted((a, b) => a.localeCompare(b, "en"))).toEqual(engines);
  await expect.poll(async () => (await stream(request)).standbys.map(({ path }) => path)).toEqual(["direct"]);
});

test("the engine it left gets hot again as the direct path's standby, and the stream stays put", async ({
  request,
}) => {
  await expect
    .poll(async () => (await standbys(request)).join(", "), { timeout: 240_000, intervals: [2000] })
    .toBe("direct hot");
  // Sticky: a healthy stream never moves to a standby that is just as good.
  const before = await waitForSteadyPlaying(request, run.streamId);
  for (let check = 0; check < 5; check += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await stream(request)).toMatchObject({ path: VPN_PATH, state: "playing", recoveries: before.recoveries });
  }
});

test("with engines shared per path, the standby is a session on the other path's engine", async ({ request }) => {
  await patchSettings(request, { sharedEngines: true });
  await expect
    .poll(
      async () => {
        const view = await stream(request);
        const standby = view.standbys.map(
          ({ path, state, engine }) => `${path} ${state} shared=${String(engine?.shared)}`,
        );
        return `${view.path ?? "none"} shared=${String(view.engine?.shared)}; ${standby.join(", ")}`;
      },
      { timeout: 300_000, intervals: [2000] },
    )
    .toBe(`${VPN_PATH} shared=true; direct hot shared=true`);
  // The engines of its own are gone: one shared engine per path plays the stream and its standby.
  await expect.poll(() => engineContainers(run.streamId), { timeout: 60_000 }).toEqual([]);
  expect(sharedEngineContainers()).toHaveLength(2);
  expect((await snapshot(request)).hotStandby.enabled).toBe(true);
});

test("fails over to the direct path's shared engine when the VPN's engine stops answering", async ({ request }) => {
  const before = await waitForSteadyPlaying(request, run.streamId);
  expect(before.engine?.shared).toBe(true);
  pauseEngine(before.engine!.name);
  let states: Set<StreamState>;
  try {
    states = await statesUntilOn(request, "direct");
  } finally {
    unpauseEngines();
  }
  expect(states.has("recovering")).toBe(false);
  const after = await stream(request);
  expect(after.engine?.shared).toBe(true);
  expect(after.recoveries).toBe(before.recoveries + 1);
});

test("turning hot standby off removes the standbys", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Streams", exact: true }).click();
  const toggle = page
    .getByRole("dialog", { name: "Streams" })
    .getByRole("switch", { name: "Hot standby on other paths" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect((await snapshot(request)).hotStandby.enabled).toBe(false);
  await expect.poll(async () => standbys(request), { timeout: 60_000 }).toEqual([]);
  // The stream plays on.
  expect((await stream(request)).state).toBe("playing");
});
