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

/**
 * The engine reports speeds in KiB/s: on a steady download its downloaded bytes grew by 1013 to
 * 1030 (mean 1023) per unit, not 1000. So 1024 units are 1 MiB/s, as Grafana's KiBs unit says it
 * too.
 */
export function formatSpeed(kilobytesPerSecond: number | null): string {
  if (kilobytesPerSecond === null) {
    return "–";
  }
  if (kilobytesPerSecond >= 1024) {
    return `${(kilobytesPerSecond / 1024).toFixed(1)} MiB/s`;
  }
  return `${String(Math.round(kilobytesPerSecond))} KiB/s`;
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

/** The top bar's count of the streams that were turned off, such as "1 disabled"; undefined when none was. */
export function formatDisabledCount(streams: readonly Pick<StreamView, "enabled" | "state">[]): string | undefined {
  const count = streams.filter((stream) => shownState(stream) === "stopped").length;
  return count === 0 ? undefined : `${String(count)} disabled`;
}

export function pathLabel(path: string | null, paths: readonly PathStatus[]): string {
  if (path === null) {
    return "–";
  }
  const known = paths.find((candidate) => candidate.id === path);
  if (known !== undefined) {
    return known.label;
  }
  // The gateway labels a tunnel with its profile's name, so this is the label it would have sent.
  return path === "direct" ? "Direct" : path.replace(/^wg:/, "");
}

const STANDBY_LABELS: Record<StandbyState, string> = {
  starting: "starting",
  warming: "warming up",
  hot: "hot",
  failed: "failed",
};

/**
 * A stream's standbys on other paths, such as "mullvad-de (hot)", with why one is not hot when the
 * controller knows (and `withReasons`), such as "mullvad-de (warming up: ffmpeg decoded no video from
 * it)"; "–" without any.
 */
export function formatStandbys(
  standbys: readonly StandbyView[],
  paths: readonly PathStatus[],
  withReasons = true,
): string {
  const labels = standbys.map(({ path, state, reason }) => {
    const detail = withReasons && reason !== null ? `${STANDBY_LABELS[state]}: ${reason}` : STANDBY_LABELS[state];
    return `${pathLabel(path, paths)} (${detail})`;
  });
  return labels.length === 0 ? "–" : labels.join(", ");
}

/** The reasons of the standbys that have one, a line each, such as "mullvad-de: ffmpeg decoded no video from it". */
export function standbyReasons(standbys: readonly StandbyView[], paths: readonly PathStatus[]): string {
  return standbys
    .filter(({ reason }) => reason !== null)
    .map(({ path, reason }) => `${pathLabel(path, paths)}: ${String(reason)}`)
    .join("\n");
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
