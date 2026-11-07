/**
 * Types shared between the services and the browser UI. They describe JSON payloads, so every
 * field is plain data (timestamps are ISO strings).
 */

import type { AceIdKind } from "./ace-id.ts";

export type { AceIdKind } from "./ace-id.ts";
export type { NetworkPolicy } from "./network-policy.ts";

/** Lifecycle of a stream as seen by the controller. */
export type StreamState =
  "starting" | "buffering" | "playing" | "stalled" | "recovering" | "switching" | "stopped" | "error";

export const STREAM_STATES: readonly StreamState[] = [
  "starting",
  "buffering",
  "playing",
  "stalled",
  "recovering",
  "switching",
  "stopped",
  "error",
];

export interface CountryCount {
  /** ISO 3166-1 alpha-2 code, upper case. */
  code: string;
  count: number;
}

export interface PeerSummary {
  /** Peers the engine reports as connected. */
  connected: number | null;
  /** Peers that sent us data during the last measurement window (from connection tracking). */
  active: number | null;
  /** Top countries of the peers, most common first. */
  countries: CountryCount[];
}

export interface StreamView {
  id: string;
  /** Acestream content ID or infohash (40 hex characters). */
  aceId: string;
  /** Which of the two `aceId` turned out to be; null until the engine accepted it. */
  aceIdKind: AceIdKind | null;
  name: string;
  enabled: boolean;
  createdAt: string;
  state: StreamState;
  stateSince: string;
  message: string | null;
  /** Last time the pipeline produced a new video frame. */
  lastFrameAt: string | null;
  peers: PeerSummary;
  downloadKBps: number | null;
  uploadKBps: number | null;
  /** Network path currently used by the stream's engine ("direct" or "wg:<profile>"). */
  path: string | null;
  recoveries: number;
  /** The engine the stream plays from; shared engines serve every stream on their path. */
  engine: { name: string; shared: boolean } | null;
  /** Engines on other paths that already pull the stream, ready to take over (hot standby). */
  standbys: StandbyView[];
  /** Players showing the stream full screen right now. */
  viewers: number;
  hls: {
    preview: string;
    full: string;
    thumbnail: string;
  };
}

/**
 * How far a standby is: its engine or session is starting, it is opening its session and waiting
 * for data, data arrives (it can take over at once), or it failed and tries again later.
 */
export type StandbyState = "starting" | "warming" | "hot" | "failed";

export interface StandbyView {
  /** The network path it pulls the stream through. */
  path: string;
  state: StandbyState;
  /** Its engine, once it answers; a shared engine also plays other streams. */
  engine: { name: string; shared: boolean } | null;
}

export type PathKind = "direct" | "wireguard";

export interface PathStatus {
  id: string;
  kind: PathKind;
  label: string;
  up: boolean;
  rttMs: number | null;
  /** Packet loss ratio between 0 and 1 from the last probe. */
  loss: number | null;
  handshakeAgeSeconds: number | null;
  /** Health score between 0 (unusable) and 1 (perfect). */
  score: number;
  lastProbeAt: string | null;
  error: string | null;
}

export interface WireguardProfileView {
  name: string;
  endpoint: string | null;
  addresses: string[];
  createdAt: string;
}

export interface Snapshot {
  generatedAt: string;
  streams: StreamView[];
  paths: PathStatus[];
  pathStrategy: PathStrategyName;
  /** Streams only use WireGuard paths; the direct path is off. */
  wireguardOnly: boolean;
  sharedEngines: SharedEnginesView;
  hotStandby: HotStandbyView;
  /** How often players report the stream they show full screen. */
  viewerPingSeconds: number;
}

/** Settings the UI changes (`PATCH /api/settings`), kept in the controller's data volume. */
export interface Settings {
  /** Streams on the same network path share one engine instead of each having its own. */
  sharedEngines: boolean;
  /** Every stream also pulls its broadcast on the other paths, ready to take over at once. */
  hotStandby: boolean;
}

export interface HotStandbyView {
  enabled: boolean;
  /** How many other paths each stream keeps a standby on, best first; 0 means all of them. */
  maxPaths: number;
  /** With a hot standby, a stream fails over after this long without new video. */
  failoverSeconds: number;
}

export interface SharedEnginesView {
  enabled: boolean;
  /** A shared engine restarts once more than this many of its streams fail within the window. */
  maxFailures: number;
  failureWindowSeconds: number;
}

/** A player showing a stream full screen. */
export interface ViewerView {
  /** Random id the page made up when it loaded; it is kept only in the page's memory. */
  viewer: string;
  stream: string;
  /** Rough browser and system, such as "Chrome on Android TV". */
  device: string;
  since: string;
}

export type PathStrategyName = "sticky-best" | "round-robin";

// ---- Transcoder API -------------------------------------------------------------------------

export type PipelineState = "starting" | "running" | "exited";

export interface PipelineRequest {
  /** HTTP URL of the MPEG-TS stream to read (the engine's playback URL). */
  source: string;
}

export interface PipelineStatus {
  id: string;
  state: PipelineState;
  source: string;
  startedAt: string;
  lastFrameAt: string | null;
  frames: number;
  fps: number | null;
  videoCodec: string | null;
  mode: "copy" | "transcode";
  exitCode: number | null;
  error: string | null;
  /** Source waiting to take over (make-before-break handover), if any. */
  pendingSource: string | null;
}

/** One standby session the transcoder reads to keep it pulling the stream (`PUT /standbys/:id`). */
export interface StandbyReaderStatus {
  source: string;
  /** Data arrives, it is connecting, or it waits to connect again after the connection ended. */
  state: "connecting" | "receiving" | "waiting";
  bytes: number;
  lastDataAt: string | null;
  error: string | null;
}

// ---- Network gateway API --------------------------------------------------------------------

export interface PeerStats {
  ip: string;
  connected: number;
  /** Peers whose traffic grew since the previous sample; null without conntrack accounting. */
  active: number | null;
  countries: CountryCount[];
  updatedAt: string;
}

export interface PathAssignment {
  ip: string;
  path: string;
}
