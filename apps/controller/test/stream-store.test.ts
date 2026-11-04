import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { DuplicateStreamError, StreamStore } from "../src/stream-store.ts";

const ID_A = "6d325cda6ed591647ef5e91edd043147bce8be30";
const ID_B = "b146ee4b6e16c9df58e27bd02ffd6cea840ff212";

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aceswarm-store-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

describe("StreamStore", () => {
  it("persists additions, updates and removals across instances", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    const a = await store.add({ aceId: ID_A, name: " Sports " });
    const b = await store.add({ aceId: ID_B });
    expect(a).toMatchObject({ aceId: ID_A, aceIdKind: null, name: "Sports", enabled: true, path: null });
    expect(b.name).toBe("Stream b146ee");

    await store.update(a.id, { aceIdKind: "infohash", path: "direct" });
    await store.remove(b.id);

    const reloaded = new StreamStore(directory);
    await reloaded.load();
    expect(reloaded.list()).toEqual([expect.objectContaining({ id: a.id, aceIdKind: "infohash", path: "direct" })]);
  });

  it("rejects duplicates", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    await store.add({ aceId: ID_A });
    await expect(store.add({ aceId: ID_A })).rejects.toBeInstanceOf(DuplicateStreamError);
  });

  it("serializes concurrent writes", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    const ids = Array.from({ length: 10 }, (_, index) => index.toString(16).padStart(40, "a"));
    await Promise.all(ids.map((aceId) => store.add({ aceId })));
    const file = JSON.parse(await readFile(join(directory, "streams.json"), "utf8")) as { streams: unknown[] };
    expect(file.streams).toHaveLength(10);
  });

  it("loads files written before aceIdKind existed", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    const stream = await store.add({ aceId: ID_A });
    const legacy = { ...stream } as Partial<typeof stream>;
    delete legacy.aceIdKind;
    const { writeJsonFile } = await import("../src/json-file.ts");
    await writeJsonFile(join(directory, "streams.json"), { version: 1, streams: [legacy] });
    const reloaded = new StreamStore(directory);
    await reloaded.load();
    expect(reloaded.get(stream.id)?.aceIdKind).toBeNull();
  });

  it("returns copies, not internal state", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    const stream = await store.add({ aceId: ID_A });
    const copy = store.get(stream.id)!;
    copy.name = "changed";
    expect(store.get(stream.id)?.name).not.toBe("changed");
    expect(await store.update("missing", { name: "x" })).toBeUndefined();
    expect(await store.remove("missing")).toBe(false);
  });
});
