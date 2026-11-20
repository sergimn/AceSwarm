import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * ENGINE_CACHE_DIR moves the engines' stream cache from memory to a folder on the host. The stack
 * runs without it, so this spec restarts the controller with it, as an edit of `.env` and
 * `docker compose up -d` do, and puts the stack back at the end. See e2e/README.md.
 */
test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus) {
    await attachServiceState("controller");
  }
});

const DISK_CACHE_MB = 64;
const DISK_CACHE_BYTES = DISK_CACHE_MB * 1024 * 1024;
/** What the image under test is called in the E2E stack (e2e/compose.e2e.yaml). */
const ENGINE_IMAGE = "aceswarm-engine:e2e";

const bc: Broadcast[] = [];
const run = {
  /** The host folder the engines keep their cache in. */
  dir: "",
  /** Whether the controller runs with ENGINE_CACHE_DIR right now. */
  onDisk: false,
  /** The first stream, and the folders its engines made. */
  firstId: "",
  firstFolders: [] as string[],
};

async function controllerIsUp(request: APIRequestContext): Promise<void> {
  await expect
    .poll(async () => (await request.get("/healthz").catch(() => undefined))?.ok(), { timeout: 60_000 })
    .toBe(true);
}

/**
 * The host folders mounted into an engine container, as "<host folder>><where in the container>".
 * The engine images also declare a volume, which is no host folder.
 */
function hostFolders(engine: string): string {
  const binds = '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}>{{.Destination}} {{end}}{{end}}';
  return docker("inspect", "-f", binds, engine).trim();
}

/** What is in the cache folder, as an engine sees it (the engines' folders belong to other users). */
function cacheEntries(engine: string): string[] {
  return engineExec(engine, "ls", "-A", "/cache")
    .split("\n")
    .filter((name) => name.length > 0)
    .toSorted((a, b) => a.localeCompare(b, "en"));
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

test.beforeAll(async ({ request }) => {
  await resetStack(request);
  bc.push(...(await broadcasts(2)));
  // On a disk: the runner's own temporary folder, where it has one.
  run.dir = mkdtempSync(path.join(process.env["RUNNER_TEMP"] ?? tmpdir(), "aceswarm-e2e-cache-"));
  // A temporary folder is closed to everyone but its owner. The engine's user is another one, so
  // open it the way a folder made with mkdir is.
  chmodSync(run.dir, 0o755);
  // Things of the user's own in the folder, one of them named like an engine's.
  writeFileSync(path.join(run.dir, "keep.txt"), "mine\n");
  mkdirSync(path.join(run.dir, "engine-notes"));
  writeFileSync(path.join(run.dir, "engine-notes", "note.txt"), "mine too\n");
});

test.afterAll(async ({ request }) => {
  if (run.onDisk) {
    await stackUp();
    await controllerIsUp(request);
  }
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

test("an engine keeps its stream cache in a folder of its own under ENGINE_CACHE_DIR", async ({ request }) => {
  run.onDisk = true;
  await stackUp({ ENGINE_CACHE_DIR: run.dir, ENGINE_DISK_CACHE_MB: String(DISK_CACHE_MB) });
  await controllerIsUp(request);

  const stream = await addStream(request, bc[0]!.infohash, "Cache on disk");
  run.firstId = stream.id;
  await waitForPlaying(request, stream.id);
  const [engine] = engineContainers(stream.id);
  expect(engine).toBeDefined();

  // The controller mounted the folder and passed the size on.
  expect(hostFolders(engine!)).toBe(`${run.dir}>/cache`);
  expect(docker("inspect", "-f", "{{json .Config.Env}}", engine!)).toContain(
    `"ACESWARM_DISK_CACHE_BYTES=${String(DISK_CACHE_BYTES)}"`,
  );

  // The engine got a folder named after its container, which only root can change, with a data
  // folder for the engine's user in it.
  const folder = `engine-${engineExec(engine!, "hostname").trim()}`;
  expect(engineFolders(engine!)).toEqual([folder]);
  expect(engineExec(engine!, "stat", "-c", "%u:%g %a", `/cache/${folder}`).trim()).toBe("0:0 755");
  expect(engineExec(engine!, "stat", "-c", "%u:%g", `/cache/${folder}/data`).trim()).toBe("1000:1000");
  expect(engineCommandLines(engine!)).toContain(
    `--cache-dir /cache/${folder}/data --live-cache-type disk --disk-cache-limit ${String(DISK_CACHE_BYTES)} --cache-auto 0`,
  );
  // The folder stays locked while the engine runs, which is what keeps other engines from removing it.
  expect(() => engineExec(engine!, "flock", "-n", `/cache/${folder}/.aceswarm-lock`, "true")).toThrow();

  // The stream's data goes to a file there, and keeps coming.
  await expect.poll(() => cachedBytes(engine!, folder), { timeout: 120_000 }).toBeGreaterThan(1024 * 1024);
  const before = cachedBytes(engine!, folder);
  await expect.poll(() => cachedBytes(engine!, folder), { timeout: 60_000 }).toBeGreaterThan(before);

  // The controller reports no memory cache for it: none in use, and no cap.
  const metrics = async (): Promise<string> => await (await request.get("/metrics")).text();
  const labels = String.raw`\{stream="${stream.id}",engine="[^"]+"[^}]*\}`;
  const memory = new RegExp(String.raw`^aceswarm_engine_memory_bytes${labels} (\S+)$`, "m");
  await expect.poll(async () => memory.test(await metrics()), { timeout: 60_000 }).toBe(true);
  const text = await metrics();
  expect(new RegExp(String.raw`^aceswarm_engine_memory_cache_bytes${labels} (\S+)$`, "m").exec(text)?.[1]).toBe("0");
  expect(text).not.toMatch(new RegExp(`^aceswarm_engine_memory_cache_limit_bytes${labels} `, "m"));
  const usedMb = Math.round(Number(memory.exec(text)?.[1]) / 1024 / 1024);
  const fileMb = Math.round(cachedBytes(engine!, folder) / 1024 / 1024);
  const description = `engine memory with its cache on disk: ${String(usedMb)} MB, with ${String(fileMb)} MB in the cache file`;
  test.info().annotations.push({ type: "cache on disk", description });
  process.stdout.write(`${description}\n`);

  // Nothing else in the folder was touched.
  expect(cacheEntries(engine!)).toEqual([folder, "engine-notes", "keep.txt"]);
  run.firstFolders = engineFolders(engine!);
});

test("the next engine that starts removes the folder of an engine that is gone", async ({ request }) => {
  expect(run.firstFolders.length).toBeGreaterThan(0);
  const removed = await request.delete(`/api/streams/${run.firstId}`);
  expect(removed.ok(), await removed.text()).toBe(true);
  await expect.poll(() => engineContainers(run.firstId), { timeout: 60_000 }).toEqual([]);

  const stream = await addStream(request, bc[1]!.infohash, "Cache on disk, next");
  await waitForPlaying(request, stream.id);
  const [engine] = engineContainers(stream.id);
  expect(engine).toBeDefined();

  const folders = engineFolders(engine!);
  expect(folders).toContain(`engine-${engineExec(engine!, "hostname").trim()}`);
  expect(folders.filter((folder) => run.firstFolders.includes(folder))).toEqual([]);
  // Only engines' folders went, and nothing is left half removed.
  expect(cacheEntries(engine!)).toEqual(
    [...folders, "engine-notes", "keep.txt"].toSorted((a, b) => a.localeCompare(b, "en")),
  );
  expect(readFileSync(path.join(run.dir, "keep.txt"), "utf8")).toBe("mine\n");
  expect(readFileSync(path.join(run.dir, "engine-notes", "note.txt"), "utf8")).toBe("mine too\n");
});

test("without ENGINE_CACHE_DIR a new engine keeps its cache in memory again", async ({ request }) => {
  await resetStack(request);
  await stackUp();
  run.onDisk = false;
  await controllerIsUp(request);

  const stream = await addStream(request, bc[0]!.infohash, "Cache in memory");
  await waitForPlaying(request, stream.id);
  const [engine] = engineContainers(stream.id);
  expect(engine).toBeDefined();

  expect(hostFolders(engine!)).toBe("");
  expect(docker("inspect", "-f", "{{json .Config.Env}}", engine!)).toContain('"ACESWARM_DISK_CACHE_BYTES=0"');
  const commands = engineCommandLines(engine!);
  expect(commands).toContain("--live-cache-type memory");
  expect(commands).not.toContain("--disk-cache-limit");
});
