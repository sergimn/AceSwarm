import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger } from "@aceswarm/shared/logger";
import { createService } from "@aceswarm/shared/service";
import { expect, test } from "vitest";
import type { Orchestrator } from "../src/orchestrator.ts";
import { registerRoutes } from "../src/server.ts";

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
