import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { PathAssignment, Snapshot, StreamView } from "../../packages/shared/src/api-types.ts";

const PROJECT = process.env["COMPOSE_PROJECT_NAME"] ?? "aceswarm-e2e";

export async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get("/api/snapshot");
  expect(response.ok()).toBe(true);
  return (await response.json()) as Snapshot;
}

export async function streamById(request: APIRequestContext, id: string): Promise<StreamView | undefined> {
  return (await snapshot(request)).streams.find((stream) => stream.id === id);
}

export async function addStream(request: APIRequestContext, aceId: string, name?: string): Promise<StreamView> {
  const response = await request.post("/api/streams", { data: { aceId, name } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as StreamView;
}

/** Waits until the stream is playing and returns its latest view. Real engines need a while. */
export async function waitForPlaying(request: APIRequestContext, id: string, timeout = 180_000): Promise<StreamView> {
  await expect.poll(async () => (await streamById(request, id))?.state, { timeout, intervals: [1000] }).toBe("playing");
  const stream = await streamById(request, id);
  if (stream === undefined) {
    throw new Error(`stream ${id} disappeared`);
  }
  return stream;
}

/**
 * Waits until the stream has kept playing, with no new recovery, for `steadyMs`. That is longer
 * than the stall window (12 s in the E2E stack), so a stall that began just before, after a
 * network cut for example, shows up and recovers first.
 */
export async function waitForSteadyPlaying(
  request: APIRequestContext,
  id: string,
  steadyMs = 20_000,
  timeout = 240_000,
): Promise<StreamView> {
  const deadline = Date.now() + timeout;
  let since = await waitForPlaying(request, id, timeout);
  let steadySince = Date.now();
  while (Date.now() - steadySince < steadyMs) {
    expect(Date.now(), `stream ${id} never played steadily`).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = await streamById(request, id);
    if (current?.state !== "playing" || current.recoveries !== since.recoveries) {
      since = await waitForPlaying(request, id, Math.max(deadline - Date.now(), 1000));
      steadySince = Date.now();
    }
  }
  return since;
}

/**
 * Removes every stream and WireGuard profile, and turns engine sharing and hot standby off, so
 * each spec starts from an empty stack with one engine per stream (standby.spec.ts turns hot
 * standby on).
 */
export async function resetStack(request: APIRequestContext): Promise<void> {
  // WireGuard only keeps the last profile, so it goes first.
  const policy = await request.patch("/api/network", { data: { wireguardOnly: false } });
  expect(policy.ok(), await policy.text()).toBe(true);
  const settings = await request.patch("/api/settings", { data: { sharedEngines: false, hotStandby: false } });
  expect(settings.ok(), await settings.text()).toBe(true);
  const { streams } = await snapshot(request);
  for (const stream of streams) {
    await request.delete(`/api/streams/${stream.id}`);
  }
  const profiles = (await (await request.get("/api/wireguard")).json()) as { name: string }[];
  for (const profile of profiles) {
    await request.delete(`/api/wireguard/${profile.name}`);
  }
}

export interface NetworkDialog {
  dialog: Locator;
  /** A section of the dialog, by its heading. */
  section: (title: string) => Locator;
  /** The "WireGuard only" switch. */
  toggle: Locator;
}

/** Opens the Network dialog from the home screen. */
export async function openNetwork(page: Page): Promise<NetworkDialog> {
  await page.goto("/");
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Network" });
  const section = (title: string) => dialog.locator(".section", { has: page.getByRole("heading", { name: title }) });
  return { dialog, section, toggle: dialog.getByRole("switch", { name: "WireGuard only" }) };
}

/** Uploads a WireGuard profile through the Network dialog, as a user would, and waits for its path. */
export async function addProfileFromUi(page: Page, name: string, config: string): Promise<void> {
  const { dialog, section } = await openNetwork(page);
  await dialog.getByLabel("Profile name").fill(name);
  await dialog.getByLabel("…or paste its contents").fill(config);
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(section("WireGuard profiles").locator(".row", { hasText: name })).toBeVisible();
  await expect(section("Paths").locator(".row", { hasText: name })).toContainText("Up", { timeout: 90_000 });
}

/** Runs `docker` against the test stack (the specs run on the machine that hosts it). */
export function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function compose(...args: string[]): string {
  return docker("compose", "-p", PROJECT, ...args);
}

const execFileAsync = promisify(execFile);

/**
 * `compose`, without blocking: the spec's own polling (of a playlist, say) goes on while it runs.
 * `compose` blocks the whole worker until the command exits.
 */
export async function composeAsync(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["compose", "-p", PROJECT, ...args], { encoding: "utf8" });
  return stdout;
}

/** Names of the engine containers the controller created for a stream. */
export function engineContainers(streamId: string): string[] {
  return docker("ps", "--filter", `label=aceswarm.stream=${streamId}`, "--format", "{{.Names}}")
    .split("\n")
    .filter((name) => name.length > 0);
}

/**
 * Every engine container of the test stack, stopped ones too (own, shared and standby), as
 * "<name> <id>". A new engine can get the name of one that was removed, so the id tells them apart.
 */
export function stackEngines(): string[] {
  const stack = process.env["ACESWARM_STACK_NAME"] ?? "aceswarm-e2e";
  return docker("ps", "-a", "--filter", `label=aceswarm.stack=${stack}`, "--format", "{{.Names}} {{.ID}}")
    .split("\n")
    .filter((name) => name.length > 0)
    .toSorted((a, b) => a.localeCompare(b, "en"));
}

/** Names of the shared engine containers (one per network path while engine sharing is on). */
export function sharedEngineContainers(): string[] {
  return docker("ps", "--filter", "label=aceswarm.shared-path", "--format", "{{.Names}}")
    .split("\n")
    .filter((name) => name.length > 0)
    .toSorted((a, b) => a.localeCompare(b, "en"));
}

/** The gateway's current engine-to-path assignments. */
export function gatewayAssignments(): PathAssignment[] {
  const output = compose("exec", "-T", "netgw", "wget", "-qO-", "http://127.0.0.1:8082/assignments");
  return JSON.parse(output) as PathAssignment[];
}

/**
 * Calls the gateway's own API from inside its container (busybox wget there can only GET). The
 * gateway refuses requests from the engines network, and its API is not published.
 */
export function gatewayRequest(method: string, path: string, body?: unknown): { status: number; body: string } {
  const script = `
    const [method, url, body] = process.argv.slice(1);
    const init = { method, headers: { "content-type": "application/json" } };
    if (body !== "") init.body = body;
    const response = await fetch(url, init);
    console.log(JSON.stringify({ status: response.status, body: await response.text() }));
  `;
  const args = [method, `http://127.0.0.1:8082${path}`, body === undefined ? "" : JSON.stringify(body)];
  const output = compose("exec", "-T", "netgw", "node", "--input-type=module", "-e", script, ...args);
  return JSON.parse(output) as { status: number; body: string };
}

/** Like `gatewayAssignments`, but undefined while the gateway is not answering. */
export function tryGatewayAssignments(): PathAssignment[] | undefined {
  try {
    return gatewayAssignments();
  } catch {
    return undefined;
  }
}

/** A compose service's address on the engines network. */
export function engineNetworkIp(service: string): string {
  const [container] = compose("ps", "-q", service).split("\n", 1);
  return docker(
    "inspect",
    "-f",
    `{{(index .NetworkSettings.Networks "${PROJECT}_engines").IPAddress}}`,
    container ?? service,
  ).trim();
}

/** Fetches a URL from inside an engine container, as the engine's own user. */
export function fetchFromEngine(engine: string, url: string): { ok: boolean; output: string } {
  try {
    const output = docker(
      "exec",
      "--user",
      "1000:1000",
      engine,
      "/usr/local/lib/aceswarm/busybox",
      "wget",
      "-T",
      "3",
      "-qO-",
      url,
    );
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: String((error as { stderr?: unknown }).stderr ?? error) };
  }
}

/**
 * The running engines the controller reports by kind (aceswarm_engines, which the dashboard's
 * "Engines running" adds up); undefined before its first sample, or when it could not list them.
 */
export async function reportedEngines(
  request: APIRequestContext,
): Promise<{ own: number; shared: number } | undefined> {
  const response = await request.get("/metrics");
  expect(response.ok()).toBe(true);
  const text = await response.text();
  // The registry adds a default service label.
  const value = (kind: string): number | undefined => {
    const match = new RegExp(String.raw`^aceswarm_engines\{kind="${kind}"[^}]*\} (\S+)$`, "m").exec(text);
    return match === null ? undefined : Number(match[1]);
  };
  const own = value("own");
  const shared = value("shared");
  return own === undefined || shared === undefined ? undefined : { own, shared };
}
