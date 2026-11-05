import type { PathStatus } from "@aceswarm/shared/api-types";
import { describe, expect, it } from "vitest";
import { initialPath, pathScore, rememberHealth, switchTarget, type PathMemory } from "../src/path-selector.ts";

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

const noLoad = new Map<string, number>();

describe("pathScore and memory", () => {
  it("mixes probes with the stream's own history", () => {
    const memory: PathMemory = new Map();
    expect(pathScore(path("direct", 1), memory)).toBeCloseTo(0.8);
    for (let index = 0; index < 200; index += 1) {
      rememberHealth(memory, "direct", false);
    }
    expect(pathScore(path("direct", 1), memory)).toBeLessThan(0.62);
    expect(pathScore(path("direct", 1, false), memory)).toBe(0);
  });
});

describe("initialPath", () => {
  const paths = [path("direct", 0.9), path("wg:a", 0.95), path("wg:b", 0.5, false)];

  it("reuses the remembered path while it is up", () => {
    expect(initialPath({ strategy: "sticky-best", paths, memory: new Map(), load: noLoad, remembered: "direct" })).toBe(
      "direct",
    );
    expect(initialPath({ strategy: "sticky-best", paths, memory: new Map(), load: noLoad, remembered: "wg:b" })).toBe(
      "wg:a",
    );
  });

  it("round robin spreads streams by load", () => {
    const load = new Map([
      ["direct", 3],
      ["wg:a", 1],
    ]);
    expect(initialPath({ strategy: "round-robin", paths, memory: new Map(), load, remembered: null })).toBe("wg:a");
  });

  it("returns nothing when no path is up", () => {
    expect(
      initialPath({
        strategy: "sticky-best",
        paths: [path("direct", 1, false)],
        memory: new Map(),
        load: noLoad,
        remembered: null,
      }),
    ).toBeUndefined();
  });
});

describe("switchTarget", () => {
  it("leaves a failing path for the best other one, even one with a lower score", () => {
    // The stream doesn't play on its path although the path answers pings, for example because
    // the connection blocks the stream's peers.
    const paths = [path("direct", 0.95), path("wg:a", 0.6), path("wg:b", 0.8), path("wg:c", 0.99, false)];
    expect(switchTarget({ strategy: "sticky-best", paths, memory: new Map(), current: "direct" })).toBe("wg:b");
  });

  it("prefers the path the stream played well on", () => {
    const paths = [path("direct", 0.95), path("wg:a", 0.6), path("wg:b", 0.8)];
    const memory = new Map([["wg:a", 1]]);
    expect(switchTarget({ strategy: "sticky-best", paths, memory, current: "direct" })).toBe("wg:a");
  });

  it("always leaves a path that is down", () => {
    const paths = [path("direct", 0, false), path("wg:a", 0.1)];
    expect(switchTarget({ strategy: "sticky-best", paths, memory: new Map(), current: "direct" })).toBe("wg:a");
  });

  it("stays when there is no alternative", () => {
    expect(
      switchTarget({
        strategy: "sticky-best",
        paths: [path("direct", 0.2)],
        memory: new Map(),
        current: "direct",
      }),
    ).toBeUndefined();
  });

  it("round robin moves to the next path that is up", () => {
    const paths = [path("direct", 1), path("wg:a", 1, false), path("wg:b", 1)];
    expect(switchTarget({ strategy: "round-robin", paths, memory: new Map(), current: "direct" })).toBe("wg:b");
    expect(switchTarget({ strategy: "round-robin", paths, memory: new Map(), current: "wg:b" })).toBe("direct");
  });
});
