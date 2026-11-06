import { expect, it } from "vitest";
import { createLogger } from "../src/logger.ts";
import { createService, isBlockedClient, shutDown } from "../src/service.ts";

const engines = ["172.31.250.0/24"];

it("recognises clients on a blocked network, also as IPv4-mapped IPv6", () => {
  expect(isBlockedClient("172.31.250.130", engines)).toBe(true);
  expect(isBlockedClient("::ffff:172.31.250.130", engines)).toBe(true);
  expect(isBlockedClient("172.18.0.3", engines)).toBe(false);
  expect(isBlockedClient("::1", engines)).toBe(false);
  expect(isBlockedClient(undefined, engines)).toBe(false);
});

it("lets the service's own address through, which rootless Podman forwards published ports from", () => {
  expect(isBlockedClient("172.31.250.144", engines, "172.31.250.144")).toBe(false);
  expect(isBlockedClient("::ffff:172.31.250.144", engines, "::ffff:172.31.250.144")).toBe(false);
  expect(isBlockedClient("172.31.250.130", engines, "172.31.250.144")).toBe(true);
});

it("refuses every request from a blocked network", async () => {
  const service = createService({ name: "test", logger: createLogger("test", "silent"), blockedClients: engines });
  service.app.put("/assignments/:ip", () => ({ ok: true }));

  const fromEngine = await service.app.inject({
    method: "PUT",
    url: "/assignments/172.31.250.130",
    remoteAddress: "172.31.250.130",
  });
  expect(fromEngine.statusCode).toBe(403);

  const fromBackend = await service.app.inject({
    method: "PUT",
    url: "/assignments/172.31.250.130",
    remoteAddress: "172.18.0.3",
  });
  expect(fromBackend.statusCode).toBe(200);
  await service.app.close();
});

it("exits after its shutdown timeout when a shutdown step hangs", async () => {
  const service = createService({ name: "test", logger: createLogger("test", "silent") });
  const exits: number[] = [];
  const started = Date.now();
  await new Promise<void>((resolve) => {
    void shutDown(service, createLogger("test", "silent"), () => new Promise(() => undefined), {
      timeoutMs: 50,
      exit: (code) => {
        exits.push(code);
        resolve();
      },
    });
  });
  expect(exits).toEqual([0]);
  expect(Date.now() - started).toBeLessThan(1000);
  await service.app.close();
});

it("exits once, right after a shutdown that finishes", async () => {
  const service = createService({ name: "test", logger: createLogger("test", "silent") });
  const exits: number[] = [];
  await shutDown(service, createLogger("test", "silent"), () => Promise.resolve(), {
    timeoutMs: 20,
    exit: (code) => {
      exits.push(code);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(exits).toEqual([0]);
});
