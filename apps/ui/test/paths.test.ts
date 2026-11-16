import { describe, expect, it } from "vitest";
import type { PathStatus, StandbyView, StreamView } from "@aceswarm/shared/api-types";
import { formatPathLoad, formatPathsUp, isPathOff, pathLoads, usablePaths } from "../src/paths.ts";

function path(id: string, up: boolean): PathStatus {
  return {
    id,
    kind: id === "direct" ? "direct" : "wireguard",
    label: id,
    up,
    rttMs: null,
    loss: null,
    handshakeAgeSeconds: null,
    score: up ? 1 : 0,
    lastProbeAt: null,
    error: null,
  };
}

function stream(overrides: Partial<StreamView>): StreamView {
  return {
    enabled: true,
    path: "direct",
    engine: { name: "engine", shared: false },
    standbys: [],
    ...overrides,
  } as StreamView;
}

const standby = (pathId: string, state: StandbyView["state"]): StandbyView => ({ path: pathId, state, engine: null });

describe("the top bar's paths up", () => {
  const paths = [path("direct", true), path("wg:a", false)];

  it("counts every path while streams may use them all", () => {
    expect(formatPathsUp({ paths, wireguardOnly: false })).toBe("1/2 network paths up");
    expect(formatPathsUp({ paths: [path("direct", true), path("wg:a", true)], wireguardOnly: false })).toBe(
      "2/2 network paths up",
    );
  });

  it("leaves the direct path out while WireGuard only is on: no stream may use it", () => {
    // The tunnel is down, so no usable path is up although the gateway reports Direct as up.
    expect(formatPathsUp({ paths, wireguardOnly: true })).toBe("0/1 network paths up");
    expect(formatPathsUp({ paths: [path("direct", true), path("wg:a", true)], wireguardOnly: true })).toBe(
      "1/1 network paths up",
    );
    expect(usablePaths({ paths, wireguardOnly: true }).map((candidate) => candidate.id)).toEqual(["wg:a"]);
  });

  it("calls only the direct path Off, and only under WireGuard only", () => {
    expect(isPathOff(path("direct", true), true)).toBe(true);
    expect(isPathOff(path("direct", true), false)).toBe(false);
    expect(isPathOff(path("wg:a", true), true)).toBe(false);
  });
});

describe("what runs on each path", () => {
  it("counts a stream on the path of its engine, and its standbys on theirs", () => {
    const loads = pathLoads([
      stream({ path: "direct", standbys: [standby("wg:a", "hot")] }),
      stream({ path: "direct", standbys: [standby("wg:a", "warming"), standby("wg:b", "starting")] }),
      stream({ path: "wg:a" }),
    ]);
    expect(loads.get("direct")).toEqual({ streams: 2, standbys: 0 });
    expect(loads.get("wg:a")).toEqual({ streams: 1, standbys: 2 });
    expect(loads.get("wg:b")).toEqual({ streams: 0, standbys: 1 });
  });

  it("does not count a disabled stream", () => {
    const loads = pathLoads([
      stream({ enabled: false, path: "direct", engine: null }),
      // Even one that still reports what it had.
      stream({ enabled: false, path: "direct", standbys: [standby("wg:a", "hot")] }),
    ]);
    expect(loads.size).toBe(0);
  });

  it("does not count a stream that has no engine, or a standby waiting for its next try", () => {
    const loads = pathLoads([
      // Waiting for a path, or its start failed: it remembers a path but runs on none.
      stream({ path: "direct", engine: null }),
      stream({ path: "wg:a", standbys: [standby("direct", "failed"), standby("wg:b", "hot")] }),
    ]);
    expect(loads.get("direct")).toBeUndefined();
    expect(loads.get("wg:a")).toEqual({ streams: 1, standbys: 0 });
    expect(loads.get("wg:b")).toEqual({ streams: 0, standbys: 1 });
  });

  it("words the figures, naming standbys only when there are some", () => {
    expect(formatPathLoad(undefined)).toEqual(["0 streams"]);
    expect(formatPathLoad({ streams: 1, standbys: 0 })).toEqual(["1 stream"]);
    expect(formatPathLoad({ streams: 3, standbys: 1 })).toEqual(["3 streams", "1 standby"]);
    expect(formatPathLoad({ streams: 0, standbys: 2 })).toEqual(["0 streams", "2 standbys"]);
  });
});
