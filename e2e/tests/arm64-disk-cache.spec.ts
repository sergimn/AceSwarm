import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  addStream,
  attachServiceState,
  docker,
  engineContainers,
  engineExec,
  resetStack,
  stackUp,
  waitForPlaying,
} from "./helpers.ts";
import { broadcasts, type Broadcast } from "./mesh.ts";

/**
 * The goal of the arm64 work: the Android engine (arm64, the Raspberry Pi's engine) keeps its stream
 * cache in a folder under ENGINE_CACHE_DIR, as the x86_64 engine does in disk-cache.spec.ts. It only
 * runs on the arm64 runner of the E2E workflow, and checks that the arm64 engine does that. The
 * x86_64 runs skip it. See engine/arm64-shim.py.
 */
test.skip(process.arch !== "arm64", "the arm64 engine only: the arm64 leg of the E2E workflow runs this");
test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus) {
    await attachServiceState("controller");
  }
});

const CACHE_MB = 64;
const CACHE_BYTES = CACHE_MB * 1024 * 1024;
/** What the image under test is called in the E2E stack (e2e/compose.e2e.yaml). */
const ENGINE_IMAGE = "aceswarm-engine:e2e";
/** Above this the engine's memory counts as a full memory cache, which the disk cache must avoid. */
const MAX_ENGINE_MB = 250;

const run = {
  /** The host folder the engines keep their cache in. */
  dir: "",
  /** The broadcast this runner plays: its own, as in the other stack runners (E2E_BROADCASTS). */
  broadcast: undefined as Broadcast | undefined,
};

async function controllerIsUp(request: APIRequestContext): Promise<void> {
  await expect
    .poll(async () => (await request.get("/healthz").catch(() => undefined))?.ok(), { timeout: 60_000 })
    .toBe(true);
}

/** The folders engines made in the cache folder: the ones with a lock file. */
function engineFolders(engine: string): string[] {
  return engineExec(engine, "sh", "-c", "ls -d /cache/engine-*/.aceswarm-lock")
    .split("\n")
    .filter((name) => name.length > 0)
    .map((lock) => path.basename(path.dirname(lock)));
}

/** Bytes of stream data in the engine's cache files. */
function cachedBytes(engine: string, folder: string): number {
  const sizes = engineExec(
    engine,
    "sh",
    "-c",
    `find /cache/${folder}/data -type f -name 'live.*' -exec stat -c %s {} +`,
  );
  return sizes
    .split("\n")
    .filter((size) => size.length > 0)
    .reduce((sum, size) => sum + Number(size), 0);
}

/** The command lines of every process in the engine container. */
function engineCommandLines(engine: string): string {
  return engineExec(engine, "sh", "-c", String.raw`cat /proc/[0-9]*/cmdline | tr '\0' ' '`);
}

/** The engine's log, stdout and stderr both (the shim writes to stderr). */
function engineLog(engine: string): string {
  return execFileSync("sh", ["-c", 'docker logs "$1" 2>&1', "sh", engine], { encoding: "utf8" });
}

test.beforeAll(async ({ request }) => {
  await resetStack(request);
  const [bc] = await broadcasts(1);
  run.broadcast = bc;
  // The runner's own temporary folder, closed to everyone but its owner; the engine's user is another one.
  run.dir = mkdtempSync(path.join(process.env["RUNNER_TEMP"] ?? tmpdir(), "aceswarm-e2e-arm64-cache-"));
  chmodSync(run.dir, 0o755);
});

test.afterAll(async ({ request }) => {
  await resetStack(request);
  try {
    // The engines' folders belong to root and to the engine's user of the containers.
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "/usr/local/lib/aceswarm/busybox",
      "-v",
      `${run.dir}:/cache`,
      ENGINE_IMAGE,
      "sh",
      "-c",
      "rm -rf /cache/engine-* /cache/.aceswarm-*",
    );
    rmSync(run.dir, { recursive: true, force: true });
  } catch {
    // Housekeeping on a runner that is thrown away: not a result.
  }
});

test("the arm64 engine keeps its stream cache in a folder under ENGINE_CACHE_DIR", async ({ request }) => {
  await stackUp({ ENGINE_CACHE_DIR: run.dir, ENGINE_DISK_CACHE_MB: String(CACHE_MB) });
  await controllerIsUp(request);

  const stream = await addStream(request, run.broadcast!.infohash, "Cache on disk, arm64");
  await waitForPlaying(request, stream.id);
  const [engine] = engineContainers(stream.id);
  expect(engine).toBeDefined();

  // The engine was started for the disk, with the cap and without the engine's own cache sizing.
  expect(engineCommandLines(engine!)).toContain(
    `--live-cache-type disk --disk-cache-limit ${String(CACHE_BYTES)} --cache-auto 0`,
  );
  // The engine's own log says so: its pick of the cache type, and the stream's cache (use_disk=0 is
  // the memory cache, as the engine logs it).
  await expect.poll(() => engineLog(engine!), { timeout: 120_000 }).toMatch(/set default live cache type: type=disk/);
  await expect.poll(() => engineLog(engine!), { timeout: 120_000 }).toContain("use_disk=1");

  // The engine's folder under the cache folder, which only root can change, with its data folder for
  // the engine's user in it.
  const folder = `engine-${engineExec(engine!, "hostname").trim()}`;
  expect(engineFolders(engine!)).toEqual([folder]);
  expect(engineExec(engine!, "stat", "-c", "%u:%g", `/cache/${folder}/data`).trim()).toBe("1000:1000");

  // The stream's data goes to the file there and keeps coming, and the file never passes the cap.
  await expect.poll(() => cachedBytes(engine!, folder), { timeout: 180_000 }).toBeGreaterThan(1024 * 1024);
  const grown = cachedBytes(engine!, folder);
  expect(grown).toBeLessThanOrEqual(CACHE_BYTES);
  await expect.poll(() => cachedBytes(engine!, folder), { timeout: 120_000 }).toBeGreaterThan(grown);
  expect(cachedBytes(engine!, folder)).toBeLessThanOrEqual(CACHE_BYTES);

  // The engine's memory stays well under what a memory cache of this size takes.
  const metrics = async (): Promise<string> => await (await request.get("/metrics")).text();
  const memory = new RegExp(
    String.raw`^aceswarm_engine_memory_bytes\{stream="${stream.id}",engine="[^"]+"[^}]*\} (\S+)$`,
    "m",
  );
  await expect.poll(async () => memory.test(await metrics()), { timeout: 60_000 }).toBe(true);
  const usedText = memory.exec(await metrics())?.[1] ?? "NaN";
  const usedMb = Math.round(Number(usedText) / 1024 / 1024);
  const description = `arm64 engine memory with its cache on disk: ${String(usedMb)} MB`;
  test.info().annotations.push({ type: "cache on disk", description });
  process.stdout.write(`${description}\n`);
  expect(usedMb).toBeLessThan(MAX_ENGINE_MB);

  // The stream plays through the whole run.
  await waitForPlaying(request, stream.id);
});
