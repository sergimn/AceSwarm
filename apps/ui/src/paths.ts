import type { PathStatus, Snapshot, StreamView } from "@aceswarm/shared/api-types";
import { formatDisabledCount, shownState } from "./format.ts";

/**
 * The direct path while WireGuard only is on. The gateway still probes it, and so it can report it
 * up, but no stream may use it: it is Off, not Up or Down.
 */
export function isPathOff(path: Pick<PathStatus, "kind">, wireguardOnly: boolean): boolean {
  return wireguardOnly && path.kind === "direct";
}

/** The paths streams may use. */
export function usablePaths(snapshot: Pick<Snapshot, "paths" | "wireguardOnly">): PathStatus[] {
  return snapshot.paths.filter((path) => !isPathOff(path, snapshot.wireguardOnly));
}

/**
 * The top bar's count of the paths streams may use that are up, such as "1/2 network paths up". It
 * says so when the gateway doesn't answer: the paths are there and the streams may play on them,
 * but nobody knows their health, so "0/0" or "0/2" would be wrong.
 */
export function formatPathsUp(snapshot: Pick<Snapshot, "paths" | "wireguardOnly" | "gatewayReachable">): string {
  if (!snapshot.gatewayReachable) {
    return "network gateway unreachable";
  }
  const usable = usablePaths(snapshot);
  return `${String(usable.filter((path) => path.up).length)}/${String(usable.length)} network paths up`;
}

/** The top bar: how many streams there are, how many play and how many are turned off, and the paths that are up. */
export function formatSummary(
  snapshot: Pick<Snapshot, "streams" | "paths" | "wireguardOnly" | "gatewayReachable">,
): string {
  const live = snapshot.streams.filter((stream) => shownState(stream) === "playing").length;
  return [
    count(snapshot.streams.length, "stream"),
    `${String(live)} live`,
    formatDisabledCount(snapshot.streams),
    formatPathsUp(snapshot),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

/** What runs through one path right now. */
export interface PathLoad {
  /** Streams that have an engine on the path, whatever state they are in. */
  streams: number;
  /** Standbys that pull a stream through the path, or are about to. */
  standbys: number;
}

/**
 * What runs on each path, by path id. A stream counts on the path of its engine: one without an
 * engine (disabled, or waiting for a path) runs nowhere, whichever path it used last. (The path
 * strategy balances on something else: the controller counts the streams whose last path it is,
 * with or without an engine.) A standby counts from the moment it is wanted, starting up included;
 * one that failed waits for its next try and pulls nothing.
 */
export function pathLoads(streams: readonly StreamView[]): Map<string, PathLoad> {
  const loads = new Map<string, PathLoad>();
  const load = (path: string): PathLoad => {
    let current = loads.get(path);
    if (current === undefined) {
      current = { streams: 0, standbys: 0 };
      loads.set(path, current);
    }
    return current;
  };
  for (const stream of streams) {
    if (!stream.enabled) {
      continue;
    }
    if (stream.path !== null && stream.engine !== null) {
      load(stream.path).streams += 1;
    }
    for (const standby of stream.standbys) {
      if (standby.state !== "failed") {
        load(standby.path).standbys += 1;
      }
    }
  }
  return loads;
}

function count(amount: number, noun: string): string {
  return `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;
}

/** A path row's figures for the load: "3 streams", and "2 standbys" when any pull through it. */
export function formatPathLoad(load: PathLoad | undefined): string[] {
  const { streams, standbys } = load ?? { streams: 0, standbys: 0 };
  return [count(streams, "stream"), ...(standbys > 0 ? [count(standbys, "standby")] : [])];
}
