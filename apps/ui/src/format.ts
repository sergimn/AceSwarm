import type {
  CountryCount,
  PathStatus,
  PeerSummary,
  StandbyState,
  StandbyView,
  StreamState,
  StreamView,
} from "@aceswarm/shared/api-types";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Age of the last new frame: "Now" under a minute, then minutes, hours or days. A stream that is
 * not playing gets no new frames, so it never says "Now": under a minute it counts the seconds.
 */
export function formatFreshness(lastFrameAt: string | null, now: number, playing = true): string {
  const at = lastFrameAt === null ? NaN : Date.parse(lastFrameAt);
  if (Number.isNaN(at)) {
    return "Never";
  }
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < MINUTE) {
    return playing ? "Now" : `${String(Math.max(1, Math.floor(seconds)))}s ago`;
  }
  if (seconds < HOUR) {
    return `${String(Math.floor(seconds / MINUTE))}m ago`;
  }
  if (seconds < DAY) {
    return `${String(Math.floor(seconds / HOUR))}h ago`;
  }
  return `${String(Math.floor(seconds / DAY))}d ago`;
}

export function isFresh(lastFrameAt: string | null, now: number, playing = true): boolean {
  return formatFreshness(lastFrameAt, now, playing) === "Now";
}

/** Peers that sent data are the useful ones, so they come first. A stopped stream has none to count. */
export function formatPeers(peers: PeerSummary, state?: StreamState): string {
  if (state === "stopped") {
    return "–";
  }
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

/**
 * Only a stream the user disabled is stopped, and "Disabled" says that it was their choice: the
 * stream may well work.
 */
export const STATE_LABELS: Record<StreamState, string> = {
  starting: "Starting",
  buffering: "Buffering",
  playing: "Live",
  stalled: "Stalled",
  "stale-source": "Waiting for source",
  recovering: "Recovering",
  switching: "Switching path",
  stopped: "Disabled",
  error: "Error",
};

/** The state to show: a disabled stream is stopped from the moment it is disabled. */
export function shownState(stream: Pick<StreamView, "enabled" | "state">): StreamState {
  return stream.enabled ? stream.state : "stopped";
}

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

const STANDBY_LABELS: Record<StandbyState, string> = {
  starting: "starting",
  warming: "warming up",
  hot: "hot",
  failed: "failed",
};

/** A stream's standbys on other paths, such as "VPN A (hot)"; "–" without any. */
export function formatStandbys(standbys: readonly StandbyView[], paths: readonly PathStatus[]): string {
  const labels = standbys.map((standby) => `${pathLabel(standby.path, paths)} (${STANDBY_LABELS[standby.state]})`);
  return labels.length === 0 ? "–" : labels.join(", ");
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
