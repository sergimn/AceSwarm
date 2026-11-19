import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { BulkAddResponse, PathAssignment, Snapshot, StreamView } from "../../packages/shared/src/api-types.ts";

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

/** Adds a list of streams in one request, one per line, started right away: every line must be a new stream. */
export async function addStreamList(request: APIRequestContext, lines: readonly string[]): Promise<StreamView[]> {
  const response = await request.post("/api/streams/bulk", { data: { text: lines.join("\n") } });
  expect(response.status(), await response.text()).toBe(200);
  const { results } = (await response.json()) as BulkAddResponse;
  expect(results.map((result) => result.status)).toEqual(lines.map(() => "added"));
  return results.map((result) => result.stream!);
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

/** The Network dialog's parts, whether it is open or not. */
export function networkDialog(page: Page): NetworkDialog {
  const dialog = page.getByRole("dialog", { name: "Network" });
  const section = (title: string) => dialog.locator(".section", { has: page.getByRole("heading", { name: title }) });
  return { dialog, section, toggle: dialog.getByRole("switch", { name: "WireGuard only" }) };
}

/** Opens the Network dialog from the home screen. */
export async function openNetwork(page: Page): Promise<NetworkDialog> {
  await page.goto("/");
  await page.getByRole("button", { name: "Network", exact: true }).click();
  return networkDialog(page);
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
export async function composeAsyncWithin(timeoutMs: number, ...args: string[]): Promise<string> {
  // A command that hangs is killed after `timeoutMs`, and it fails.
  const { stdout } = await execFileAsync("docker", ["compose", "-p", PROJECT, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return stdout;
}

/** `composeAsyncWithin` with a two-minute limit, for a start or a stop that takes seconds. */
export function composeAsync(...args: string[]): Promise<string> {
  return composeAsyncWithin(120_000, ...args);
}

/**
 * A `docker` command for diagnostics. It is synchronous, so it's bounded: a wedged daemon must not
 * hang the worker, and a wedged daemon is the very case the diagnostics are for. A killed command
 * throws, and the caller records that as the section's failure.
 */
function bounded(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
}

/**
 * Attaches what the stack says about one service to the running test's report: its container state
 * (status, exit code, OOM kill, restarts, timestamps) and its last log lines. For a failure that a
 * spec's own assertion can't explain, such as a service that never came back up.
 */
export async function attachServiceState(service: string): Promise<void> {
  const sections: string[] = [];
  const section = (label: string, run: () => string): void => {
    try {
      sections.push(`## ${label}\n${run().trimEnd() || "(no output)"}`);
    } catch (error) {
      sections.push(`## ${label}\n(failed: ${error instanceof Error ? error.message : String(error)})`);
    }
  };
  section("compose ps -a", () => bounded("compose", "-p", PROJECT, "ps", "-a", service));
  section("container state", () => {
    const id = bounded("compose", "-p", PROJECT, "ps", "-a", "-q", service).trim();
    if (id === "") {
      return "no container";
    }
    return bounded(
      "inspect",
      "--format",
      "status={{.State.Status}} exitCode={{.State.ExitCode}} oomKilled={{.State.OOMKilled}} restarts={{.RestartCount}} startedAt={{.State.StartedAt}} finishedAt={{.State.FinishedAt}} error={{.State.Error}}",
      id,
    );
  });
  section("compose logs (last 200 lines)", () =>
    bounded("compose", "-p", PROJECT, "logs", "--no-color", "--tail", "200", service),
  );
  try {
    await test.info().attach(`${service}-state.txt`, { body: sections.join("\n\n"), contentType: "text/plain" });
  } catch {
    // The attachment is a diagnostic: a failure to write it must not replace the test's own error.
  }
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
 * One series' value in the controller's metrics text, by its name and its first labels (such as
 * `stream="…"`); undefined when it has none. The registry adds a service label of its own.
 */
export function metricValue(text: string, name: string, labels: string): number | undefined {
  const match = new RegExp(String.raw`^${name}\{${labels}[^}]*\} (\S+)$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The stream's recoveries that brought video back, by the step that counted
 * (aceswarm_stream_recoveries_succeeded_total, which the dashboard's "Recoveries per hour" and
 * "Recoveries in range" add up). Every step has a count from the stream's start, 0 at first.
 */
export async function recoveriesSucceeded(
  request: APIRequestContext,
  streamId: string,
): Promise<Record<string, number>> {
  const response = await request.get("/metrics");
  expect(response.ok()).toBe(true);
  const text = await response.text();
  const counts: Record<string, number> = {};
  for (const action of ["restart-pipeline", "restart-engine", "switch-path", "failover"]) {
    // The registry adds a default service label.
    const labels = `stream="${streamId}",action="${action}"[^}]*`;
    const line = new RegExp(String.raw`^aceswarm_stream_recoveries_succeeded_total\{${labels}\} (\S+)$`, "m").exec(
      text,
    );
    expect(line, `no count of the stream's ${action} recoveries`).not.toBeNull();
    counts[action] = Number(line?.[1]);
  }
  return counts;
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
