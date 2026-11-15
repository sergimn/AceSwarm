import type { PeerStats, PipelineStatus, StandbyView, StreamState, StreamView } from "@aceswarm/shared/api-types";
import type { EngineStats } from "./acestream.ts";
import type { EngineHandle } from "./engines.ts";
import { hlsUrls } from "./hls-urls.ts";
import type { StreamConfig } from "./stream-store.ts";

/** What a supervisor knows about a running stream. */
export interface LiveStream {
  state: StreamState;
  stateSince: number;
  message: string | null;
  pipeline: PipelineStatus | undefined;
  stats: EngineStats | undefined;
  peers: PeerStats | undefined;
  recoveries: number;
  engine: EngineHandle | undefined;
  standbys: StandbyView[];
}

/** The later of two frame times, either of which there may be none of. */
export function newestFrame(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return a ?? b;
  }
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The API's view of a stream: a running one's live state, or a stopped one's configuration. */
export function streamView(stream: StreamConfig, viewers: number, live?: LiveStream): StreamView {
  return {
    id: stream.id,
    aceId: stream.aceId,
    aceIdKind: stream.aceIdKind,
    name: stream.name,
    enabled: stream.enabled,
    createdAt: stream.createdAt,
    // A stopped stream has no engine, so it is on no path. Its config keeps the one it was on, to
    // start there again.
    path: live === undefined ? null : stream.path,
    // The last video of any of its sessions: a pipeline only knows its own, and a stopped stream
    // has none.
    lastFrameAt: newestFrame(stream.lastFrameAt, live?.pipeline?.lastFrameAt ?? null),
    viewers,
    hls: hlsUrls(stream.id),
    ...(live === undefined ? stopped(stream) : running(live)),
  };
}

type LiveFields = Omit<StreamView, keyof StreamConfig | "viewers" | "hls">;

function stopped(stream: StreamConfig): LiveFields {
  return {
    state: "stopped",
    stateSince: stream.createdAt,
    message: null,
    liveEdge: null,
    peers: { connected: null, active: null, uploading: null, countries: [] },
    downloadKBps: null,
    uploadKBps: null,
    recoveries: 0,
    engine: null,
    standbys: [],
  };
}

/**
 * Peers the gateway saw the engine send stream data to. The engine's own upload speed counts only
 * stream data, so while it is 0 whatever the gateway saw is the engine's other traffic to its peers,
 * and none of them counts.
 */
function uploadingPeers(stats: EngineStats | undefined, peers: PeerStats | undefined): number | null {
  const uploading = peers?.uploading ?? null;
  return uploading !== null && stats?.speedUp === 0 ? 0 : uploading;
}

function running(live: LiveStream): LiveFields {
  const { stats, peers, engine } = live;
  return {
    state: live.state,
    stateSince: new Date(live.stateSince).toISOString(),
    message: live.message,
    liveEdge: live.pipeline?.liveEdge ?? null,
    peers: {
      connected: stats?.peers ?? peers?.connected ?? null,
      active: peers?.active ?? null,
      uploading: uploadingPeers(stats, peers),
      countries: peers?.countries.slice(0, 3) ?? [],
    },
    downloadKBps: stats?.speedDown ?? null,
    uploadKBps: stats?.speedUp ?? null,
    recoveries: live.recoveries,
    engine: engine === undefined ? null : { name: engine.name, shared: engine.sharedPath !== null },
    standbys: live.standbys,
  };
}
