import type { EnginePeerTraffic, PeerTraffic } from "@aceswarm/shared/api-types";
import { expect, test } from "vitest";
import { PeerTrafficMonitor } from "../src/peer-traffic.ts";

const peer = (ip: string, downBytes: number): PeerTraffic => ({
  ip,
  country: "ES",
  downBytes,
  upBytes: 0,
  downBytesPerSecond: 0,
  upBytesPerSecond: 0,
});

test("keeps each engine's peers as the gateway last counted them, and none once it doesn't answer", async () => {
  let answer: EnginePeerTraffic[] | Error = [
    { ip: "172.31.250.130", peers: [peer("1.1.1.1", 500)], updatedAt: "2026-11-26T12:00:00.000Z" },
    { ip: "172.31.250.131", peers: [], updatedAt: "2026-11-26T12:00:00.000Z" },
  ];
  const monitor = new PeerTrafficMonitor({
    peerTraffic: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  });
  // Before the first sample there is nothing to show.
  expect(monitor.of("172.31.250.130")).toEqual([]);

  await monitor.sample();
  expect(monitor.of("172.31.250.130")).toEqual([peer("1.1.1.1", 500)]);
  expect(monitor.of("172.31.250.131")).toEqual([]);
  expect(monitor.of("172.31.250.132")).toEqual([]);

  // An engine that went takes its peers with it.
  answer = [{ ip: "172.31.250.131", peers: [peer("8.8.8.8", 900)], updatedAt: "2026-11-26T12:00:05.000Z" }];
  await monitor.sample();
  expect(monitor.of("172.31.250.130")).toEqual([]);
  expect(monitor.of("172.31.250.131")).toEqual([peer("8.8.8.8", 900)]);

  // The gateway restarts, or is one that has no such answer yet: old figures would pass for current ones.
  answer = new Error("HTTP 404");
  await expect(monitor.sample()).rejects.toThrow("HTTP 404");
  expect(monitor.of("172.31.250.131")).toEqual([]);
});
