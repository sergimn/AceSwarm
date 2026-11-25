import { get } from "node:http";
import type { AddressInfo } from "node:net";
import type { BulkAddResponse, Settings } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { createService } from "@aceswarm/shared/service";
import { expect, onTestFinished, test } from "vitest";
import { UnknownPathError, type Orchestrator } from "../src/orchestrator.ts";
import { registerRoutes } from "../src/server.ts";
import { DuplicateStreamError, type NewStream } from "../src/stream-store.ts";

test("closing the server ends the open event streams instead of waiting for them", async () => {
  const service = createService({ name: "controller", logger: createLogger("test", "silent") });
  const orchestrator = { snapshot: () => ({ streams: [], paths: [] }) } as unknown as Orchestrator;
  await registerRoutes(service, orchestrator, { uiDir: "/nonexistent", transcoderUrl: "http://127.0.0.1:9" });
  await service.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = service.app.server.address() as AddressInfo;

  // A browser with the UI open: the stream never ends on its own.
  const open = Promise.withResolvers<undefined>();
  const ended = new Promise<string>((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/api/events" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        open.resolve(undefined);
      });
      response.on("end", () => {
        resolve(body);
      });
    }).on("error", reject);
  });
  await open.promise;

  const started = Date.now();
  await service.app.close();
  expect(Date.now() - started).toBeLessThan(1000);
  expect(await ended).toContain("event: snapshot");
});

test("the API waits until the orchestrator started; the HLS proxy doesn't", async () => {
  const service = createService({ name: "controller", logger: createLogger("test", "silent") });
  const orchestrator = { snapshot: () => ({ streams: [], paths: [] }) } as unknown as Orchestrator;
  const ready = Promise.withResolvers<undefined>();
  await registerRoutes(service, orchestrator, {
    uiDir: "/nonexistent",
    transcoderUrl: "http://127.0.0.1:9",
    ready: ready.promise,
  });
  let answered = false;
  const api = service.app.inject({ method: "GET", url: "/api/snapshot" }).then((response) => {
    answered = true;
    return response;
  });
  // Nothing listens on the transcoder's port here, so the proxy answers 502 right away.
  const hls = await service.app.inject({ method: "GET", url: "/hls/abcdef/full/index.m3u8" });
  expect(hls.statusCode).toBe(502);
  expect(answered).toBe(false);

  ready.resolve(undefined);
  expect((await api).statusCode).toBe(200);
  await service.app.close();
});

test("restarting a stream with no run says whether it is disabled, not running yet or unknown", async () => {
  const service = createService({ name: "controller", logger: createLogger("test", "silent") });
  const orchestrator = {
    restartStream: () => false,
    getStream: (id: string) =>
      id === "abcdef" ? { id, enabled: false, state: "stopped" } : id === "mnopqr" ? { id, enabled: true } : undefined,
  } as unknown as Orchestrator;
  await registerRoutes(service, orchestrator, { uiDir: "/nonexistent", transcoderUrl: "http://127.0.0.1:9" });
  const restart = async (id: string) => service.app.inject({ method: "POST", url: `/api/streams/${id}/restart` });

  const disabled = await restart("abcdef");
  expect(disabled.statusCode).toBe(404);
  expect(disabled.json()).toEqual({ error: "stream is disabled" });
  // Enabled, but its run isn't there yet: it is not disabled.
  const starting = await restart("mnopqr");
  expect(starting.statusCode).toBe(404);
  expect(starting.json()).toEqual({ error: "stream not running" });
  const unknown = await restart("ghijkl");
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json()).toEqual({ error: "stream not found" });
  await service.app.close();
});

const ID_A = "6d325cda6ed591647ef5e91edd043147bce8be30";
const ID_B = "b146ee4b6e16c9df58e27bd02ffd6cea840ff212";
const ID_C = "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567";

/** A server over an orchestrator that keeps its streams in a list: `ID_A` is in it from the start. */
async function withStreams() {
  const service = createService({ name: "controller", logger: createLogger("test", "silent") });
  const streams = [{ id: "aaaaaa", aceId: ID_A, name: "Sports", enabled: true }];
  /** What the orchestrator was asked to add, call by call. */
  const asked: NewStream[][] = [];
  const add = (input: NewStream) => {
    const existing = streams.find((stream) => stream.aceId === input.aceId);
    if (existing !== undefined) {
      return { stream: existing, added: false };
    }
    const stream = {
      id: `s${String(streams.length)}`.padEnd(6, "x"),
      aceId: input.aceId,
      aceIdKind: input.aceIdKind ?? null,
      name: input.name ?? `Stream ${input.aceId.slice(0, 6)}`,
      enabled: input.enabled ?? true,
    };
    streams.push(stream);
    return { stream, added: true };
  };
  const orchestrator = {
    addStreams: (inputs: NewStream[]) => {
      asked.push(inputs);
      return Promise.resolve(inputs.map((input) => add(input)));
    },
    addStream: (input: NewStream) => {
      asked.push([input]);
      const outcome = add(input);
      return outcome.added ? Promise.resolve(outcome.stream) : Promise.reject(new DuplicateStreamError(input.aceId));
    },
  } as unknown as Orchestrator;
  await registerRoutes(service, orchestrator, { uiDir: "/nonexistent", transcoderUrl: "http://127.0.0.1:9" });
  onTestFinished(async () => {
    await service.app.close();
  });
  const post = async (url: string, payload: unknown) =>
    service.app.inject({ method: "POST", url, payload: payload as object });
  return { post, asked, streams };
}

test("a list of streams gets a result for every line, and one wrong line doesn't stop the others", async () => {
  const { post, asked } = await withStreams();
  const text = [
    `acestream://${ID_B}`,
    "",
    "not a stream",
    `Sports ${ID_A}`,
    `magnet:?xt=urn:btih:${ID_C}`,
    `${ID_B.toUpperCase()}, ${"d".repeat(40)}`,
    "x".repeat(300),
  ].join("\n");
  const response = await post("/api/streams/bulk", { text });
  expect(response.statusCode).toBe(200);
  const body = response.json<BulkAddResponse>();
  expect({ added: body.added, duplicates: body.duplicates, invalid: body.invalid }).toEqual({
    added: 3,
    duplicates: 2,
    invalid: 2,
  });
  expect(body.results.map(({ line, status, aceId, repeatsLine }) => ({ line, status, aceId, repeatsLine }))).toEqual([
    { line: 1, status: "added", aceId: ID_B, repeatsLine: null },
    { line: 3, status: "invalid", aceId: null, repeatsLine: null },
    { line: 4, status: "duplicate", aceId: ID_A, repeatsLine: null },
    { line: 5, status: "added", aceId: ID_C, repeatsLine: null },
    { line: 6, status: "duplicate", aceId: ID_B, repeatsLine: 1 },
    { line: 6, status: "added", aceId: "d".repeat(40), repeatsLine: null },
    { line: 7, status: "invalid", aceId: null, repeatsLine: null },
  ]);
  // Every result names its line and, when the line has a stream, the stream that has it now.
  expect(body.results[0]).toMatchObject({ text: `acestream://${ID_B}`, stream: { aceId: ID_B, enabled: true } });
  expect(body.results[1]).toMatchObject({ text: "not a stream", stream: null });
  expect(body.results[2]).toMatchObject({ text: `Sports ${ID_A}`, stream: { id: "aaaaaa", name: "Sports" } });
  expect(body.results[4]?.stream).toEqual(body.results[0]?.stream);
  // A long line comes back cut.
  expect(body.results[6]?.text).toBe("x".repeat(200));
  // The streams were asked for together, each once, with the kind its line said.
  expect(asked).toEqual([
    [
      { aceId: ID_B, aceIdKind: null, enabled: true },
      { aceId: ID_A, aceIdKind: null, enabled: true },
      { aceId: ID_C, aceIdKind: "infohash", enabled: true },
      { aceId: "d".repeat(40), aceIdKind: null, enabled: true },
    ],
  ]);
});

test("a list can be added disabled, and a list without streams adds nothing", async () => {
  const { post, asked } = await withStreams();
  const disabled = await post("/api/streams/bulk", { text: ID_B, enabled: false });
  expect(disabled.json<BulkAddResponse>()).toMatchObject({
    added: 1,
    results: [{ status: "added", stream: { aceId: ID_B, enabled: false } }],
  });
  expect(asked).toEqual([[{ aceId: ID_B, aceIdKind: null, enabled: false }]]);

  const nothing = await post("/api/streams/bulk", { text: "#EXTM3U\n\nnot a stream\n" });
  expect(nothing.statusCode).toBe(200);
  expect(nothing.json()).toEqual({
    results: [{ line: 3, text: "not a stream", status: "invalid", aceId: null, stream: null, repeatsLine: null }],
    added: 0,
    duplicates: 0,
    invalid: 1,
  });
});

test("a list that is no text, empty or too long is refused whole", async () => {
  const { post, asked, streams } = await withStreams();
  const refused = [
    {},
    { text: "" },
    { text: 5 },
    { text: [ID_B] },
    { text: ID_B, enabled: "no" },
    { text: ID_B, name: "Sports" },
    { text: `${ID_B}\n`.repeat(2500) },
  ];
  for (const payload of refused) {
    const response = await post("/api/streams/bulk", payload);
    expect(response.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("at most 100000 characters");
  }
  expect(asked).toEqual([]);
  expect(streams).toHaveLength(1);
});

test("a single stream is read from untidy text too, and keeps the name it was given", async () => {
  const { post, asked } = await withStreams();
  const added = await post("/api/streams", { aceId: ` "Sports 2" - acestream://${ID_B}, `, name: "Two" });
  expect(added.statusCode).toBe(201);
  expect(added.json()).toMatchObject({ aceId: ID_B, name: "Two" });
  const magnet = await post("/api/streams", { aceId: `magnet:?xt=urn:btih:${ID_C}&dn=x` });
  expect(magnet.statusCode).toBe(201);
  expect(asked).toEqual([
    [{ aceId: ID_B, aceIdKind: null, name: "Two" }],
    [{ aceId: ID_C, aceIdKind: "infohash", name: undefined }],
  ]);

  // In the list already, however it is written.
  const duplicate = await post("/api/streams", { aceId: `Sports ${ID_A.toUpperCase()}` });
  expect(duplicate.statusCode).toBe(409);
  // No stream: the text for one stream must name one.
  for (const aceId of ["not a stream", ID_A.slice(1)]) {
    const response = await post("/api/streams", { aceId });
    expect(response.statusCode, aceId).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("does not look like");
  }
  // More than one: the answer says where a list goes.
  for (const aceId of [`${ID_B} ${"d".repeat(40)}`, `${ID_B}\nacestream://${"d".repeat(40)}`]) {
    const response = await post("/api/streams", { aceId });
    expect(response.statusCode, aceId).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("more than one stream");
  }
});

test("a single stream is still read from every text it was read from before lists", async () => {
  const { post, asked } = await withStreams();
  const other = "d".repeat(40);
  const base32 = "aaaqeayeaudaocajbifqydiob4ibceqt";
  const texts = [
    // The same stream written twice.
    `acestream://${ID_B} http://127.0.0.1:6878/ace/getstream?id=${ID_B}`,
    // A magnet link with a space in its name, and one whose name holds another hash.
    `magnet:?dn=My Stream&xt=urn:btih:${base32}`,
    `magnet:?xt=urn:btih:${ID_C}&dn=copy of ${other}`,
    // An engine URL after other lines.
    `Sports\nhttp://127.0.0.1:6878/ace/getstream?infohash=${other}`,
  ];
  for (const aceId of texts) {
    const response = await post("/api/streams", { aceId });
    expect(response.statusCode, aceId).toBe(201);
  }
  expect(asked).toEqual([
    [{ aceId: ID_B, aceIdKind: "content-id", name: undefined }],
    [{ aceId: "000102030405060708090a0b0c0d0e0f10111213", aceIdKind: "infohash", name: undefined }],
    [{ aceId: ID_C, aceIdKind: "infohash", name: undefined }],
    [{ aceId: other, aceIdKind: "infohash", name: undefined }],
  ]);
});

test("settings change one at a time, and a favourite path is a path's id or null for none", async () => {
  const service = createService({ name: "controller", logger: createLogger("test", "silent") });
  let settings: Settings = { sharedEngines: false, hotStandby: true, favouritePath: null };
  const patches: Partial<Settings>[] = [];
  const orchestrator = {
    getSettings: () => settings,
    updateSettings: (patch: Partial<Settings>) => {
      patches.push(patch);
      if (patch.favouritePath === "wg:gone") {
        return Promise.reject(new UnknownPathError('There is no network path "wg:gone".'));
      }
      settings = { ...settings, ...patch };
      return Promise.resolve(settings);
    },
  } as unknown as Orchestrator;
  await registerRoutes(service, orchestrator, { uiDir: "/nonexistent", transcoderUrl: "http://127.0.0.1:9" });
  onTestFinished(async () => {
    await service.app.close();
  });
  const patch = async (payload: object) => service.app.inject({ method: "PATCH", url: "/api/settings", payload });

  const chosen = await patch({ favouritePath: "wg:vpn" });
  expect(chosen.statusCode).toBe(200);
  expect(chosen.json()).toEqual({ sharedEngines: false, hotStandby: true, favouritePath: "wg:vpn" });
  // Another setting leaves it as it is, and null takes it away.
  expect((await patch({ sharedEngines: true })).json()).toMatchObject({ favouritePath: "wg:vpn" });
  expect((await patch({ favouritePath: null })).json()).toMatchObject({ sharedEngines: true, favouritePath: null });
  expect(patches).toEqual([{ favouritePath: "wg:vpn" }, { sharedEngines: true }, { favouritePath: null }]);

  // Nothing to change changes nothing.
  expect((await patch({})).json()).toEqual(settings);
  expect(patches).toHaveLength(3);

  for (const payload of [
    { favouritePath: "" },
    { favouritePath: 1 },
    { favouritePath: "x".repeat(65) },
    { path: "direct" },
  ]) {
    const refused = await patch(payload);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "expected { sharedEngines?, hotStandby?, favouritePath? }" });
  }
  const unknown = await patch({ favouritePath: "wg:gone" });
  expect(unknown.statusCode).toBe(400);
  expect(unknown.json()).toEqual({ error: 'There is no network path "wg:gone".' });
  expect(settings.favouritePath).toBeNull();
});
