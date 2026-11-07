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

/** The API's view of a stream: a running one's live state, or a stopped one's configuration. */
export function streamView(stream: StreamConfig, viewers: number, live?: LiveStream): StreamView {
  return {
    id: stream.id,
    aceId: stream.aceId,
    aceIdKind: stream.aceIdKind,
    name: stream.name,
    enabled: stream.enabled,
    createdAt: stream.createdAt,
    path: stream.path,
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
    lastFrameAt: null,
    peers: { connected: null, active: null, countries: [] },
    downloadKBps: null,
    uploadKBps: null,
    recoveries: 0,
    engine: null,
    standbys: [],
  };
}

function running(live: LiveStream): LiveFields {
  const { stats, peers, engine } = live;
  return {
    state: live.state,
    stateSince: new Date(live.stateSince).toISOString(),
    message: live.message,
    lastFrameAt: live.pipeline?.lastFrameAt ?? null,
    peers: {
      connected: stats?.peers ?? peers?.connected ?? null,
      active: peers?.active ?? null,
      countries: peers?.countries.slice(0, 3) ?? [],
    },
    downloadKBps: stats?.speedDown ?? null,
    uploadKBps: stats?.speedUp ?? null,
    recoveries: live.recoveries,
    engine: engine === undefined ? null : { name: engine.name, shared: engine.sharedPath !== null },
    standbys: live.standbys,
  };
}
