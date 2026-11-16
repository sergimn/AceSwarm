import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as jsonFile from "../src/json-file.ts";
import { DuplicateStreamError, StreamStore } from "../src/stream-store.ts";

const ID_A = "6d325cda6ed591647ef5e91edd043147bce8be30";
const ID_B = "b146ee4b6e16c9df58e27bd02ffd6cea840ff212";
const ID_C = "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567";

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

  it("adds a list with one write, and says which streams were there already", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    const known = await store.add({ aceId: ID_A, name: "Sports" });
    const writes = vi.spyOn(jsonFile, "writeJsonFile");

    const outcomes = await store.addMany([
      { aceId: ID_B, aceIdKind: "infohash" },
      { aceId: ID_A, name: "Again" },
      { aceId: ID_C, enabled: false },
      // The same stream twice in one list is added once.
      { aceId: ID_B, name: "Twice" },
    ]);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(outcomes.map((outcome) => outcome.added)).toEqual([true, false, true, false]);
    expect(outcomes[0]?.stream).toMatchObject({
      aceId: ID_B,
      aceIdKind: "infohash",
      name: "Stream b146ee",
      enabled: true,
    });
    // The stream that has the identifier, as it is: its own name and id.
    expect(outcomes[1]?.stream).toEqual(known);
    expect(outcomes[2]?.stream).toMatchObject({ aceId: ID_C, enabled: false, path: null, lastFrameAt: null });
    expect(outcomes[3]?.stream).toEqual(outcomes[0]?.stream);

    const reloaded = new StreamStore(directory);
    await reloaded.load();
    expect(reloaded.list().map((stream) => stream.aceId)).toEqual([ID_A, ID_B, ID_C]);
    expect(new Set(reloaded.list().map((stream) => stream.id)).size).toBe(3);

    // Nothing new: nothing is written.
    writes.mockClear();
    expect((await store.addMany([{ aceId: ID_A }, { aceId: ID_C }])).map((outcome) => outcome.added)).toEqual([
      false,
      false,
    ]);
    expect(await store.addMany([])).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("adds nothing of a list when it can't be saved", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    await store.add({ aceId: ID_A });
    vi.spyOn(jsonFile, "writeJsonFile").mockRejectedValueOnce(new Error("disk full"));
    await expect(store.addMany([{ aceId: ID_B }, { aceId: ID_C }])).rejects.toThrow("disk full");
    expect(store.list().map((stream) => stream.aceId)).toEqual([ID_A]);
    // The next list starts from what is saved.
    expect((await store.addMany([{ aceId: ID_B }])).map((outcome) => outcome.added)).toEqual([true]);
    expect(store.list().map((stream) => stream.aceId)).toEqual([ID_A, ID_B]);
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

  it("keeps the session a stream plays from, and loads files written before it was kept", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    const stream = await store.add({ aceId: ID_A });
    expect(stream.session).toBeNull();
    const session = {
      playbackUrl: "http://172.31.250.10:6878/ace/r/x/y",
      statUrl: "http://172.31.250.10:6878/ace/stat/x/y",
      commandUrl: "http://172.31.250.10:6878/ace/cmd/x/y",
    };
    await store.update(stream.id, { session });
    const reloaded = new StreamStore(directory);
    await reloaded.load();
    expect(reloaded.get(stream.id)?.session).toEqual(session);

    const legacy = { ...stream } as Partial<typeof stream>;
    delete legacy.session;
    const { writeJsonFile } = await import("../src/json-file.ts");
    await writeJsonFile(join(directory, "streams.json"), { version: 1, streams: [legacy] });
    const older = new StreamStore(directory);
    await older.load();
    expect(older.get(stream.id)?.session).toBeNull();
  });

  it("keeps when a stream last had video, and loads files written before it was kept", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    const stream = await store.add({ aceId: ID_A });
    expect(stream.lastFrameAt).toBeNull();
    const lastFrameAt = "2026-11-15T20:00:00.000Z";
    await store.update(stream.id, { enabled: false, lastFrameAt });
    const reloaded = new StreamStore(directory);
    await reloaded.load();
    expect(reloaded.get(stream.id)).toMatchObject({ enabled: false, lastFrameAt });

    const legacy = { ...stream } as Partial<typeof stream>;
    delete legacy.lastFrameAt;
    const { writeJsonFile } = await import("../src/json-file.ts");
    await writeJsonFile(join(directory, "streams.json"), { version: 1, streams: [legacy] });
    const older = new StreamStore(directory);
    await older.load();
    expect(older.get(stream.id)?.lastFrameAt).toBeNull();
  });

  it("never sets the last video time back to an older one", async () => {
    const directory = await tempDirectory();
    const store = new StreamStore(directory);
    await store.load();
    const stream = await store.add({ aceId: ID_A });
    const newer = "2026-11-15T20:00:00.000Z";
    await store.update(stream.id, { lastFrameAt: newer });
    await store.update(stream.id, { lastFrameAt: "2026-11-15T19:00:00.000Z", name: "Renamed" });
    expect(store.get(stream.id)).toMatchObject({ lastFrameAt: newer, name: "Renamed" });
    await store.update(stream.id, { lastFrameAt: null });
    expect(store.get(stream.id)?.lastFrameAt).toBe(newer);
    const newest = "2026-11-15T21:00:00.000Z";
    await store.update(stream.id, { lastFrameAt: newest });
    expect(store.get(stream.id)?.lastFrameAt).toBe(newest);
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
