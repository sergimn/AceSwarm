import type { CountryCount, PathStatus, PeerSummary, StreamState } from "@aceswarm/shared/api-types";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Age of the last new frame: "Now" under a minute, then minutes, hours or days. */
export function formatFreshness(lastFrameAt: string | null, now: number): string {
  const at = lastFrameAt === null ? NaN : Date.parse(lastFrameAt);
  if (Number.isNaN(at)) {
    return "Never";
  }
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < MINUTE) {
    return "Now";
  }
  if (seconds < HOUR) {
    return `${String(Math.floor(seconds / MINUTE))}m ago`;
  }
  if (seconds < DAY) {
    return `${String(Math.floor(seconds / HOUR))}h ago`;
  }
  return `${String(Math.floor(seconds / DAY))}d ago`;
}

export function isFresh(lastFrameAt: string | null, now: number): boolean {
  return formatFreshness(lastFrameAt, now) === "Now";
}

/** Peers that sent data are the useful ones, so they come first. */
export function formatPeers(peers: PeerSummary): string {
  if (peers.active !== null && peers.connected !== null) {
    return `${String(peers.active)} sending · ${String(peers.connected)} connected`;
  }
  if (peers.connected !== null) {
    return `${String(peers.connected)} connected`;
  }
  return peers.active === null ? "Unknown" : `${String(peers.active)} sending`;
}

export function topCountries(countries: readonly CountryCount[], limit = 3): CountryCount[] {
  return [...countries].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, limit);
}

/** Engine speeds are reported in kilobytes per second. */
export function formatSpeed(kilobytesPerSecond: number | null): string {
  if (kilobytesPerSecond === null) {
    return "–";
  }
  if (kilobytesPerSecond >= 1024) {
    return `${(kilobytesPerSecond / 1024).toFixed(1)} MB/s`;
  }
  return `${String(Math.round(kilobytesPerSecond))} KB/s`;
}

export const STATE_LABELS: Record<StreamState, string> = {
  starting: "Starting",
  buffering: "Buffering",
  playing: "Live",
  stalled: "Stalled",
  recovering: "Recovering",
  switching: "Switching path",
  stopped: "Off",
  error: "Error",
};

export function pathLabel(path: string | null, paths: readonly PathStatus[]): string {
  if (path === null) {
    return "–";
  }
  const known = paths.find((candidate) => candidate.id === path);
  if (known !== undefined) {
    return known.label;
  }
  return path === "direct" ? "Direct" : path.replace(/^wg:/, "VPN ");
}

function createRegionNames(): Intl.DisplayNames | undefined {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return undefined;
  }
}

const regionNames = createRegionNames();

export function countryName(code: string): string {
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function formatRtt(rttMs: number | null): string {
  return rttMs === null ? "–" : `${String(Math.round(rttMs))} ms`;
}

export function formatLoss(loss: number | null): string {
  return loss === null ? "–" : `${String(Math.round(loss * 100))}%`;
}
