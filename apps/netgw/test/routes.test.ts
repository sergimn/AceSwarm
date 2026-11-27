import type { EnginePeerTraffic } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { createService } from "@aceswarm/shared/service";
import { expect, test } from "vitest";
import type { Gateway } from "../src/gateway.ts";
import { registerRoutes } from "../src/server.ts";

test("answers the engines' traffic with their peers, next to the peer counts of one engine", async () => {
  const traffic: EnginePeerTraffic[] = [
    {
      ip: "172.31.250.130",
      peers: [
        {
          ip: "1.1.1.1",
          country: "AU",
          downBytes: 165_000,
          upBytes: 3250,
          downBytesPerSecond: 20_000,
          upBytesPerSecond: 400,
        },
      ],
      updatedAt: "2026-11-26T12:00:00.000Z",
    },
  ];
  const asked: string[] = [];
  const gateway = {
    peers: {
      traffic: () => traffic,
      get: (ip: string) => {
        asked.push(ip);
        return { ip, connected: 1 };
      },
    },
  } as unknown as Gateway;
  const service = createService({ name: "test", logger: createLogger("test", "silent") });
  registerRoutes(service, gateway);

  const response = await service.app.inject({ method: "GET", url: "/peer-traffic" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(traffic);

  // An engine's own counts are still under /peers/<its address>.
  const counts = await service.app.inject({ method: "GET", url: "/peers/172.31.250.130" });
  expect(counts.json()).toEqual({ ip: "172.31.250.130", connected: 1 });
  expect(asked).toEqual(["172.31.250.130"]);
});
