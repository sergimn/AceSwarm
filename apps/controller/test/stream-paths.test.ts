import type { PathStatus } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { Health } from "../src/health.ts";
import { StreamPaths } from "../src/stream-paths.ts";

function path(id: string, score: number, up = true): PathStatus {
  return {
    id,
    kind: id === "direct" ? "direct" : "wireguard",
    label: id,
    up,
    rttMs: 20,
    loss: 0,
    handshakeAgeSeconds: null,
    score,
    lastProbeAt: null,
    error: null,
  };
}

/** A stream on the direct path that may also use two WireGuard paths, the first a bit better by its probes. */
function paths(): StreamPaths {
  const all = [path("direct", 1), path("wg:a", 0.9), path("wg:b", 0.85)];
  return new StreamPaths({
    paths: () => all,
    pathLoad: () => new Map(),
    strategy: "sticky-best",
    logger: createLogger("test", "silent"),
  });
}

/** What the stream's history on `wg:a` does to its place among the standby candidates. */
function candidatesAfter(health: Health): string[] {
  const streamPaths = paths();
  for (let check = 0; check < 200; check += 1) {
    streamPaths.rememberHealth("wg:a", health);
  }
  return streamPaths.standbyCandidates("direct");
}

describe("what a stream remembers about its paths", () => {
  it("counts a stall against the path it happened on", () => {
    expect(paths().standbyCandidates("direct")).toEqual(["wg:a", "wg:b"]);
    const stalled: Health = { state: "stalled", healthy: false, reason: "no new video for 30s" };
    expect(candidatesAfter(stalled)).toEqual(["wg:b", "wg:a"]);
  });

  it("holds nothing against a path while the stream starts or its broadcast sends nothing new", () => {
    const starting: Health = { state: "starting", healthy: false, reason: "waiting for video" };
    const quiet: Health = { state: "stale-source", healthy: false, reason: "no new data from the broadcast for 61s" };
    expect(candidatesAfter(starting)).toEqual(["wg:a", "wg:b"]);
    expect(candidatesAfter(quiet)).toEqual(["wg:a", "wg:b"]);
  });

  it("holds nothing against a path for an engine that serves the broadcast too far behind", () => {
    const lagging: Health = {
      state: "stalled",
      healthy: false,
      reason: "the engine serves the broadcast 103s late",
      lagging: true,
    };
    expect(candidatesAfter(lagging)).toEqual(["wg:a", "wg:b"]);
  });
});

/** A stream that may use `all` except the paths in `off`, with `favourite` set. */
function withFavourite(favourite: string | null, all: PathStatus[], off: string[] = []): StreamPaths {
  return new StreamPaths({
    paths: () => all,
    pathAllowed: (id) => !off.includes(id),
    pathLoad: () => new Map(),
    favouritePath: () => favourite,
    strategy: "sticky-best",
    logger: createLogger("test", "silent"),
  });
}

describe("the favourite path", () => {
  const all = [path("direct", 1), path("wg:a", 0.9), path("wg:b", 0.85)];

  it("comes first among the standby candidates, whatever its score", () => {
    expect(withFavourite("wg:b", all).standbyCandidates("direct")).toEqual(["wg:b", "wg:a"]);
    expect(withFavourite("direct", all).standbyCandidates("wg:a")).toEqual(["direct", "wg:b"]);
    // The stream plays on it: the others in their order.
    expect(withFavourite("direct", all).standbyCandidates("direct")).toEqual(["wg:a", "wg:b"]);
    expect(withFavourite(null, all).standbyCandidates("direct")).toEqual(["wg:a", "wg:b"]);
  });

  it("counts only while the stream may move to it: it is up, and the policy allows it", () => {
    expect(withFavourite("wg:b", all).favourite()).toBe("wg:b");
    expect(withFavourite(null, all).favourite()).toBeUndefined();
    const down = [path("direct", 1), path("wg:a", 0.9), path("wg:b", 0.85, false)];
    expect(withFavourite("wg:b", down).favourite()).toBeUndefined();
    expect(withFavourite("wg:b", down).standbyCandidates("direct")).toEqual(["wg:a"]);
    // WireGuard only turns the direct path off.
    expect(withFavourite("direct", all, ["direct"]).favourite()).toBeUndefined();
    // A path the gateway doesn't have, or while its paths are unknown.
    expect(withFavourite("wg:gone", all).favourite()).toBeUndefined();
    expect(withFavourite("wg:b", []).favourite()).toBeUndefined();
  });

  it("is where a stream starts, unless the path it used last is up", () => {
    expect(withFavourite("wg:b", all).forStart(null, 0)).toBe("wg:b");
    expect(withFavourite("wg:b", all).forStart("wg:a", 0)).toBe("wg:a");
    expect(withFavourite(null, all).forStart(null, 0)).toBe("direct");
    // A stream that doesn't start there tries another path every second failed attempt.
    expect(withFavourite("wg:b", all).forStart(null, 2)).toBe("direct");
  });
});
