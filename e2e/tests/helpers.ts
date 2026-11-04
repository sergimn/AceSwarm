import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext } from "@playwright/test";
import type { PathAssignment, Snapshot, StreamView } from "../../packages/shared/src/api-types.ts";

const PROJECT = process.env["COMPOSE_PROJECT_NAME"] ?? "aceswarm-e2e";

/**
 * Mock engine IDs: the prefix picks a behaviour (see apps/mock-engine/src/behavior.ts) and the
 * last hex digit the kind the mock accepts (0-7 content ID, 8-f infohash).
 */
export function mockId(prefix: string, kind: "content-id" | "infohash", seed: number): string {
  const body = `${prefix}${seed.toString(16).padStart(8, "0")}`.padEnd(39, "5");
  return `${body}${kind === "content-id" ? "1" : "c"}`;
}

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

/** Waits until the stream is playing and returns its latest view. */
export async function waitForPlaying(request: APIRequestContext, id: string, timeout = 90_000): Promise<StreamView> {
  await expect.poll(async () => (await streamById(request, id))?.state, { timeout, intervals: [1000] }).toBe("playing");
  const stream = await streamById(request, id);
  if (stream === undefined) {
    throw new Error(`stream ${id} disappeared`);
  }
  return stream;
}

/** Removes every stream and WireGuard profile so each spec starts from an empty stack. */
export async function resetStack(request: APIRequestContext): Promise<void> {
  const { streams } = await snapshot(request);
  for (const stream of streams) {
    await request.delete(`/api/streams/${stream.id}`);
  }
  const profiles = (await (await request.get("/api/wireguard")).json()) as { name: string }[];
  for (const profile of profiles) {
    await request.delete(`/api/wireguard/${profile.name}`);
  }
}

/** Runs `docker` against the test stack (the specs run on the machine that hosts it). */
export function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function compose(...args: string[]): string {
  return docker("compose", "-p", PROJECT, ...args);
}

/** Names of the engine containers the controller created for a stream. */
export function engineContainers(streamId: string): string[] {
  return docker("ps", "-q", "--filter", `label=aceswarm.stream=${streamId}`, "--format", "{{.Names}}")
    .split("\n")
    .filter((name) => name.length > 0);
}

/** The gateway's current engine-to-path assignments. */
export function gatewayAssignments(): PathAssignment[] {
  const output = compose("exec", "-T", "netgw", "wget", "-qO-", "http://127.0.0.1:8082/assignments");
  return JSON.parse(output) as PathAssignment[];
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

/** The client profile the throwaway WireGuard server wrote for this run. */
export function wireguardClientProfile(): string {
  return compose("exec", "-T", "wg-server", "cat", "/state/client.conf");
}
