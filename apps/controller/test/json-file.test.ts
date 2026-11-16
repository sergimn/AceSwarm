import { readFileSync } from "node:fs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { readJsonFile, writeJsonFile } from "../src/json-file.ts";

test("flushes a new file to the disk before it takes the old one's place", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aceswarm-json-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "streams.json");
  await writeJsonFile(path, { streams: ["old"] });

  // Every file handle has the same prototype: what the file under the final name holds at each
  // flush shows whether the flush came before the rename.
  const probe = await open(path, "r");
  const handles = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const sync = handles.sync;
  const atFlush: string[] = [];
  const spy = vi.spyOn(handles, "sync").mockImplementation(function (this: unknown) {
    atFlush.push(readFileSync(path, "utf8"));
    return sync.call(this);
  });
  onTestFinished(() => {
    spy.mockRestore();
  });

  await writeJsonFile(path, { streams: ["new"] });
  expect(atFlush.map((text) => JSON.parse(text) as unknown)).toEqual([{ streams: ["old"] }]);
  expect(await readJsonFile(path)).toEqual({ streams: ["new"] });
  expect(await readdir(directory)).toEqual(["streams.json"]);
});
