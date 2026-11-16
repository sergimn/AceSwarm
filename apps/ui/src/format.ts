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

/** An age in whole units: seconds under a minute (never 0), then minutes, hours or days. */
function ago(seconds: number): string {
  if (seconds < MINUTE) {
    return `${String(Math.max(1, Math.floor(seconds)))}s ago`;
  }
  if (seconds < HOUR) {
    return `${String(Math.floor(seconds / MINUTE))}m ago`;
  }
  if (seconds < DAY) {
    return `${String(Math.floor(seconds / HOUR))}h ago`;
  }
  return `${String(Math.floor(seconds / DAY))}d ago`;
}

/**
 * Age of the last new frame: "Now" under a minute, then minutes, hours or days. A stream that is
 * not playing gets no new frames, so it never says "Now": under a minute it counts the seconds.
 * `now` is the controller's time (see `PageClock`), the clock that `lastFrameAt` was taken from.
 */
export function formatFreshness(lastFrameAt: string | null, now: number, playing = true): string {
  const at = lastFrameAt === null ? NaN : Date.parse(lastFrameAt);
  if (Number.isNaN(at)) {
    return "Never";
  }
  const seconds = Math.max(0, (now - at) / 1000);
  return seconds < MINUTE && playing ? "Now" : ago(seconds);
}

/** How long ago the page last heard from the controller, such as "last update 12s ago". */
export function formatLastUpdate(silentMs: number): string {
  return `last update ${ago(Math.max(0, silentMs) / 1000)}`;
}

export function isFresh(lastFrameAt: string | null, now: number, playing = true): boolean {
  return formatFreshness(lastFrameAt, now, playing) === "Now";
}

/**
 * Peers that sent data are the useful ones, so they come first. A stopped stream has none to count.
 * On a shared engine only the connected peers are the stream's own: the sending ones are the engine's,
 * every stream on it shows the same, so they come second and say whose they are.
 */
export function formatPeers(peers: PeerSummary, state?: StreamState, sharedEngine = false): string {
  if (state === "stopped") {
    return "–";
  }
  const connected = peers.connected === null ? undefined : `${String(peers.connected)} connected`;
  const sending =
    peers.active === null ? undefined : `${String(peers.active)} sending${sharedEngine ? " on the shared engine" : ""}`;
  const shown = (sharedEngine ? [connected, sending] : [sending, connected]).filter((part) => part !== undefined);
  return shown.length === 0 ? "Unknown" : shown.join(" · ");
}

/**
 * What the Peers figures count. They come from two places: the engine reports its connected peers
 * for each stream, and the gateway sees the engine's traffic with the internet.
 */
export function peersHint(sharedEngine: boolean): string {
  return [
    "Sending: peers on the internet that sent the engine stream data in the last few seconds, as the gateway sees them.",
    "Connected: the peers the engine reports for this stream. They can include other engines of Ace Swarm, such as a hot standby, which the gateway does not see.",
    ...(sharedEngine
      ? ["The engine is shared: its sending peers and their countries are those of every stream on it."]
      : []),
  ].join(" ");
}

/** The tooltip of a country's flag: how many of the peers sending data are there. */
export function countryHint(code: string, count: number, sharedEngine: boolean): string {
  return `${countryName(code)}: ${String(count)} sending${sharedEngine ? " on the shared engine" : ""}`;
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
