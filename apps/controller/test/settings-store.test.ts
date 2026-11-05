import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { SettingsStore } from "../src/settings-store.ts";

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aceswarm-settings-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("starts with engine sharing off and keeps changes across restarts", async () => {
  const directory = await tempDirectory();
  const store = new SettingsStore(directory);
  expect(await store.load()).toBeNull();
  expect(store.get()).toEqual({ sharedEngines: false });

  expect(await store.update({ sharedEngines: true })).toEqual({ sharedEngines: true });
  const file = await readFile(join(directory, "settings.json"), "utf8");
  expect(JSON.parse(file)).toEqual({
    version: 1,
    sharedEngines: true,
  });

  const reloaded = new SettingsStore(directory);
  expect(await reloaded.load()).toBeNull();
  expect(reloaded.get()).toEqual({ sharedEngines: true });
});

test("falls back to the defaults when the file can't be understood", async () => {
  const directory = await tempDirectory();
  await writeFile(join(directory, "settings.json"), "{ not json");
  const store = new SettingsStore(directory);
  expect(await store.load()).toContain("not valid JSON");
  expect(store.get()).toEqual({ sharedEngines: false });

  await writeFile(join(directory, "settings.json"), JSON.stringify({ version: 2 }));
  expect(await store.load()).toContain("unknown format");
});
