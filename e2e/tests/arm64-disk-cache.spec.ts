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
 * cache in a folder under ENGINE_CACHE_DIR, as the x86_64 engine does in disk-cache.spec.ts, and it
 * does that for two streams at once. It only runs on the arm64 runner of the E2E workflow, and checks
 * that the arm64 engine does that. The x86_64 runs skip it. See engine/arm64-shim.py.
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
/** A bound on the engine's memory, against one that grows without a cap (about 1.7 GB uncapped, per docs/architecture.md). */
const MAX_ENGINE_MB = 250;

const run = {
  /** The host folder the engines keep their cache in. */
  dir: "",
  /** The broadcasts this runner plays: its own, as in the other stack runners (E2E_BROADCASTS). */
  broadcasts: [] as Broadcast[],
  /** The first test's stream, which the second test keeps playing next to its own. */
  firstId: "",
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

/** The engine's memory in bytes, as the controller reports it for the stream. */
async function memoryBytes(request: APIRequestContext, streamId: string): Promise<number> {
  const text = await (await request.get("/metrics")).text();
  const line = new RegExp(
    String.raw`^aceswarm_engine_memory_bytes\{stream="${streamId}",engine="[^"]+"[^}]*\} (\S+)$`,
    "m",
  );
  return Number(line.exec(text)?.[1] ?? "NaN");
}

/** The name of an engine's folder under the cache folder: named after the engine's container. */
function cacheFolderOf(engine: string): string {
  return `engine-${engineExec(engine, "hostname").trim()}`;
}

test.beforeAll(async ({ request }) => {
  await resetStack(request);
  run.broadcasts = await broadcasts(2);
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

  const stream = await addStream(request, run.broadcasts[0]!.infohash, "Cache on disk, arm64");
  run.firstId = stream.id;
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

  // The engine's folder under the cache folder, which root made and only root can change, with its
  // data folder for the engine's user in it.
  const folder = cacheFolderOf(engine!);
  expect(engineFolders(engine!)).toEqual([folder]);
  expect(engineExec(engine!, "stat", "-c", "%u:%g %a", `/cache/${folder}`).trim()).toBe("0:0 755");
  expect(engineExec(engine!, "stat", "-c", "%u:%g", `/cache/${folder}/data`).trim()).toBe("1000:1000");

  // The stream's data goes to the file there and keeps coming, and the file never passes the cap.
  await expect.poll(() => cachedBytes(engine!, folder), { timeout: 180_000 }).toBeGreaterThan(1024 * 1024);
  const grown = cachedBytes(engine!, folder);
  expect(grown).toBeLessThanOrEqual(CACHE_BYTES);
  await expect.poll(() => cachedBytes(engine!, folder), { timeout: 120_000 }).toBeGreaterThan(grown);
  expect(cachedBytes(engine!, folder)).toBeLessThanOrEqual(CACHE_BYTES);

  // The engine's memory stays under MAX_ENGINE_MB. That bound only catches an engine that grows
  // without a cap; the log and the cache file above are what show that the stream is on disk.
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

test("a second stream on the arm64 engine gets an engine and a folder of its own, and keeps its cache on disk", async ({
  request,
}) => {
  const [first] = engineContainers(run.firstId);
  expect(first).toBeDefined();
  const second = await addStream(request, run.broadcasts[1]!.infohash, "Cache on disk, arm64, second");
  await waitForPlaying(request, second.id);
  const [engine] = engineContainers(second.id);
  expect(engine).toBeDefined();
  expect(engine).not.toBe(first);

  // Each engine has a folder of its own, and those are the only two in the cache folder.
  const caches = [first!, engine!].map((name) => ({ name, folder: cacheFolderOf(name) }));
  expect(new Set(caches.map((cache) => cache.folder)).size).toBe(2);
  expect(engineFolders(engine!)).toHaveLength(2);
  expect(engineFolders(engine!)).toEqual(expect.arrayContaining(caches.map((cache) => cache.folder)));

  // Both engines keep their stream's data in a file under the cap, and it keeps coming.
  for (const { name, folder } of caches) {
    expect(engineCommandLines(name)).toContain(
      `--live-cache-type disk --disk-cache-limit ${String(CACHE_BYTES)} --cache-auto 0`,
    );
    expect(engineExec(name, "stat", "-c", "%u:%g", `/cache/${folder}/data`).trim()).toBe("1000:1000");
    await expect.poll(() => cachedBytes(name, folder), { timeout: 180_000 }).toBeGreaterThan(1024 * 1024);
    expect(cachedBytes(name, folder)).toBeLessThanOrEqual(CACHE_BYTES);
  }

  // Both engines stay under MAX_ENGINE_MB, the bound against an engine that grows without a cap.
  for (const id of [run.firstId, second.id]) {
    await expect.poll(() => memoryBytes(request, id), { timeout: 60_000 }).toBeGreaterThan(0);
    const usedMb = Math.round((await memoryBytes(request, id)) / 1024 / 1024);
    expect(usedMb).toBeLessThan(MAX_ENGINE_MB);
  }

  // Both streams play.
  await waitForPlaying(request, run.firstId);
  await waitForPlaying(request, second.id);
});
