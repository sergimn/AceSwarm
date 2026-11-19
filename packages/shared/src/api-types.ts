/**
 * Types shared between the services and the browser UI. They describe JSON payloads, so every
 * field is plain data (timestamps are ISO strings).
 */

import type { AceIdKind } from "./ace-id.ts";

export type { AceIdKind } from "./ace-id.ts";
export type { NetworkPolicy } from "./network-policy.ts";

/** Lifecycle of a stream as seen by the controller. */
export type StreamState =
  "starting" | "buffering" | "playing" | "stalled" | "stale-source" | "recovering" | "switching" | "stopped" | "error";

export const STREAM_STATES: readonly StreamState[] = [
  "starting",
  "buffering",
  "playing",
  "stalled",
  "stale-source",
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
  /** Peers the engine reports as connected for the stream's session; null while it hasn't answered. */
  connected: number | null;
  /**
   * Peers that sent stream data during the last measurement window (from connection tracking). They
   * are the engine's, so every stream on a shared engine has the same ones.
   */
  active: number | null;
  /**
   * Peers we sent stream data to during the last measurement window (from connection tracking); 0
   * while the engine reports no upload.
   */
  uploading: number | null;
  /** Top countries of the `active` peers, most common first (up to five): the engine's, like them. */
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
  /**
   * Last time players could get a new video frame of the stream, from any of its sessions: it
   * stays while the stream recovers, starts over or is disabled. Null if it never played.
   */
  lastFrameAt: string | null;
  /**
   * The live edge of the session the stream plays from (see `LiveEdgeView`): whether its broadcast
   * sends new data. Null while there is no session, or without its stats.
   */
  liveEdge: LiveEdgeView | null;
  peers: PeerSummary;
  downloadKBps: number | null;
  uploadKBps: number | null;
  /**
   * Network path of the stream's engine ("direct" or "wg:<profile>"), or the one it used last
   * while the stream has no engine; null before it has one, and while the stream is disabled.
   */
  path: string | null;
  /** Recovery steps it took since it was started, whether or not they brought video back. */
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

/** What became of one entry of a list sent to `POST /api/streams/bulk`. */
export type BulkAddStatus = "added" | "duplicate" | "invalid";

export interface BulkAddResult {
  /** The line of the list the entry is on, counted from 1. A line with several identifiers has an entry for each. */
  line: number;
  /** That line without the space around it, cut at 200 characters. */
  text: string;
  /**
   * - added: the stream is new and is in the list now.
   * - duplicate: a stream with the identifier was in the list already, or an earlier line of this
   *   list has it (see `repeatsLine`).
   * - invalid: the line has no identifier.
   */
  status: BulkAddStatus;
  /** The identifier found on the line (40 hex characters); null when it has none. */
  aceId: string | null;
  /** The stream that was added, or the one that has the identifier; null when the line has none. */
  stream: StreamView | null;
  /** The earlier line of this list with the same identifier, when the entry repeats one; else null. */
  repeatsLine: number | null;
}

/** The answer to `POST /api/streams/bulk`: a result for every entry of the list, in its order. */
export interface BulkAddResponse {
  results: BulkAddResult[];
  added: number;
  duplicates: number;
  invalid: number;
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
  /**
   * Why it is not hot, as far as the controller knows: what the transcoder's reader of its session
   * reports (such as that ffmpeg decodes no video from it), why its last try failed, or that the
   * path was given up. A path that lost its standbys stays listed as failed, without an engine,
   * for as long as it gets no new one. Null while it is hot, starting, or nothing is known.
   */
  reason: string | null;
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
  /**
   * The network gateway's paths and their health. While it doesn't answer (it restarts, or a poll
   * timed out) these are the paths of its last answer, none before it first answered: see
   * `gatewayReachable`. A profile removed meanwhile stays among them until it answers.
   */
  paths: PathStatus[];
  /**
   * Whether the gateway answered the controller's last poll (every 5 seconds). When it didn't, the
   * health in `paths` is unknown, not zero: the controller doesn't move or restart a stream because of it.
   */
  gatewayReachable: boolean;
  pathStrategy: PathStrategyName;
  /** Streams only use WireGuard paths; the direct path is off. */
  wireguardOnly: boolean;
  sharedEngines: SharedEnginesView;
  hotStandby: HotStandbyView;
  tilePreviews: TilePreviewsView;
  /** How often players report the stream they show full screen. */
  viewerPingSeconds: number;
}

/** How the grid's tiles may show their streams, as the admin set it in `.env`. */
export interface TilePreviewsView {
  /**
   * Tiles only show thumbnails (LOW_CPU_PREVIEWS), whatever a browser chose under Settings,
   * and the transcoder makes no live previews: the streams' `hls.preview` playlists stay empty.
   */
  thumbnailsOnly: boolean;
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
  /**
   * The session's stat URL. With it, the transcoder follows the engine's live edge and only
   * publishes video while the broadcast's newest data keeps moving (see `LiveEdgeView`).
   */
  stat?: string | undefined;
}

/**
 * Whether an engine session serves new data, from its live edge (`livepos.last` in its stats):
 * - waiting: no new data seen yet; a new session counts once its edge moved and it downloaded.
 * - live: the edge moves, and the engine serves close to it.
 * - stale: the edge did not move for the stale threshold, or the engine serves that far behind it.
 *   The engine still serves the old window it has, and so do peers that have it.
 * - none: the session has no live position (not a live broadcast, or no stats); its output is
 *   published as it comes.
 */
export type LiveEdgeState = "waiting" | "live" | "stale" | "none";

export interface LiveEdgeView {
  state: LiveEdgeState;
  /**
   * Why the session is stale, null while it is not:
   * - quiet: the broadcast is not known to send new data. The session's edge did not move for the
   *   stale threshold, or it serves far behind an edge while no session of the stream was seen to
   *   get new data within the threshold (a new engine on the old window of a broadcast that
   *   stopped). Nothing local can change that: the stream waits for its broadcast.
   * - behind: the broadcast sends new data (see `quietSince`), but the engine serves it more than
   *   the threshold behind its live edge. That is this session's start, not the broadcast: a new
   *   one starts close to the edge.
   *
   * Absent from a transcoder that doesn't tell: the controller then waits for the broadcast, as for
   * "quiet".
   */
  staleBecause?: "quiet" | "behind" | null;
  /** The broadcast's newest data the engine knows of, by the broadcaster's clock (can be off). */
  edgeAt: string | null;
  /** When that edge last moved (or was first seen), by the transcoder's clock. */
  advancedAt: string | null;
  /**
   * Since when the broadcast is known to send nothing new, by the transcoder's clock: the last time
   * the edge of a live session of the stream moved, or while none was live, when the stream's first
   * session saw an edge. Unlike `advancedAt`, it goes on when a new session opens: one whose peers
   * know of a slightly later end of the old window starts its own edge from now, not the broadcast.
   * A new session has it from the stream's earlier ones before it has an edge of its own.
   * Null for a session without a live position (`none`): it says nothing about the broadcast.
   */
  quietSince: string | null;
  /** How far behind its live edge the engine serves the stream, in seconds. */
  behindSeconds: number | null;
}

export interface PipelineStatus {
  id: string;
  state: PipelineState;
  source: string;
  startedAt: string;
  lastFrameAt: string | null;
  frames: number;
  /** The frame rate ffmpeg last reported (its average since it started); null while no ffmpeg runs. */
  fps: number | null;
  videoCodec: string | null;
  mode: "copy" | "transcode";
  exitCode: number | null;
  error: string | null;
  /** Source waiting to take over (make-before-break handover), if any. */
  pendingSource: string | null;
  /**
   * The live edge of the session `source` reads; null without a stat URL. `lastFrameAt` only
   * counts video the pipeline published: none before a segment of the source is in the playlist,
   * none while this waits, and none once it is stale.
   */
  liveEdge: LiveEdgeView | null;
}

/** One standby session the transcoder reads to keep it pulling the stream (`PUT /standbys/:id`). */
export interface StandbyReaderStatus {
  source: string;
  /** Data arrives, it is connecting, or it waits to connect again after the connection ended. */
  state: "connecting" | "receiving" | "waiting";
  bytes: number;
  /**
   * The last MPEG-TS stream data that came while the session's live edge moved (whenever it came,
   * without a stat URL). None counts after a decode check found no video, until one passes.
   */
  lastDataAt: string | null;
  error: string | null;
  liveEdge: LiveEdgeView | null;
}

/** A standby session for the transcoder to read: its playback URL, and its stat URL. */
export interface StandbySource {
  source: string;
  stat?: string | undefined;
}

// ---- Network gateway API --------------------------------------------------------------------

export interface PeerStats {
  ip: string;
  connected: number;
  /**
   * Peers that sent the engine at least a block of stream data since the previous sample; null
   * without conntrack accounting.
   */
  active: number | null;
  /** Peers the engine sent stream data to since the previous sample; null without accounting. */
  uploading: number | null;
  /** Top countries of the `active` peers, or of the connected ones without conntrack accounting. */
  countries: CountryCount[];
  updatedAt: string;
}

export interface PathAssignment {
  ip: string;
  path: string;
}
