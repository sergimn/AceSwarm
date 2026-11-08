import type { LiveEdgeState, LiveEdgeView } from "@aceswarm/shared/api-types";

/** What one poll of an engine session's stat URL said about its live position. */
export interface LiveSample {
  /** The session's status: "prebuf" while it buffers, "dl" while it downloads. */
  status: string;
  /** Bytes the session downloaded so far. */
  downloaded: number;
  /** `livepos.last`: the newest data of the broadcast the engine knows of (Unix seconds, broadcaster's clock). */
  last: number | undefined;
  /** `livepos.pos`: where the engine serves the stream from (same clock). */
  pos: number | undefined;
}

export interface LiveEdgeSettings {
  /** A session whose live edge did not move for this long is stale, as is one serving that far behind it. */
  staleAfterMs: number;
  /**
   * Polls in a row after which a session counts as having no live position: downloading without
   * `livepos` (not a live broadcast), or a stat URL that fails. Its output is then published as is.
   */
  noLiveAfterPolls: number;
}

/** The newest live edge a stream's sessions showed, and since when (the transcoder's clock). */
export interface LiveEdgeSeed {
  edge: number;
  since: number;
}

export const DEFAULT_LIVE_EDGE_SETTINGS: LiveEdgeSettings = { staleAfterMs: 60_000, noLiveAfterPolls: 10 };

/**
 * Follows an engine session's live edge (`livepos.last`), to tell whether what it serves is new.
 * An engine whose broadcast stopped keeps answering, keeps its peers and keeps serving the window
 * it already has (and peers that have the same old window serve it to new sessions too), so data
 * arriving says nothing. Only the live edge moving does.
 *
 * Every time here is the transcoder's own clock: `livepos` is stamped by the broadcaster's clock,
 * which can be off by minutes, so its values are only compared with each other.
 *
 * A new session of the same stream starts from what the previous one saw (`LiveEdgeSeed`): one
 * that only has the same old window is no newer, and the time since the edge last moved goes on,
 * so it is stale at once rather than after another `staleAfterMs`.
 *
 * - waiting: no new data seen yet. A new session counts once its own edge moved twice, past the
 *   newest edge the stream's previous session saw, and it downloaded. Once is not enough: for a
 *   broadcast that stopped, a peer can know of a slightly later end of the old window than the
 *   previous session did, and an engine catching up on that window sees its edge rise to it.
 * - live: the edge moved within `staleAfterMs`, and the engine serves close to it.
 * - stale: the edge did not move for `staleAfterMs` (counted from when it was first seen), or the
 *   engine serves more than `staleAfterMs` behind it.
 * - none: the session has no live position (see `noLiveAfterPolls`).
 */
export class LiveEdge {
  private readonly settings: LiveEdgeSettings;
  private readonly now: () => number;
  private readonly seed: LiveEdgeSeed | undefined;
  /** The newest `livepos.last` seen, and when it last moved (or was first seen). */
  private edge: number | undefined;
  private edgeSince: number | undefined;
  /** This session's own newest `livepos.last`, and how often it rose since the session opened. */
  private own: number | undefined;
  private advances = 0;
  /** The previous session's edge this one has to get past: the same old window is no news. */
  private baseline: number | undefined;
  private pos: number | undefined;
  private firstDownloaded: number | undefined;
  private downloaded = 0;
  /** The edge moved and the session downloaded since it opened: it is a live broadcast. */
  private verified = false;
  private polls = { withoutLivePos: 0, failed: 0 };
  private hasNoLivePos = false;

  constructor(settings: LiveEdgeSettings, now: () => number = Date.now, seed?: LiveEdgeSeed) {
    this.settings = settings;
    this.now = now;
    this.seed = seed;
  }

  /** What a next session of the same stream starts from. */
  snapshot(): LiveEdgeSeed | undefined {
    return this.edge === undefined || this.edgeSince === undefined
      ? this.seed
      : { edge: this.edge, since: this.edgeSince };
  }

  observe(sample: LiveSample): void {
    const now = this.now();
    this.polls.failed = 0;
    this.firstDownloaded ??= sample.downloaded;
    this.downloaded = sample.downloaded;
    if (sample.last === undefined) {
      // A session that buffers shows no live position for a moment; only one that downloads without
      // one, poll after poll, is not a live broadcast.
      this.polls.withoutLivePos = sample.status === "dl" && this.edge === undefined ? this.polls.withoutLivePos + 1 : 0;
      this.hasNoLivePos ||= this.polls.withoutLivePos >= this.settings.noLiveAfterPolls;
      return;
    }
    this.polls.withoutLivePos = 0;
    this.pos = sample.pos;
    if (this.own === undefined) {
      this.first(sample.last, now);
    } else if (sample.last > this.own) {
      // Only an edge newer than any this session saw counts: values going back and forth are no
      // new data.
      this.own = sample.last;
      this.advances += 1;
      if (sample.last > (this.edge ?? -Infinity)) {
        this.edge = sample.last;
        this.edgeSince = now;
      }
    }
    const pastBaseline = this.baseline === undefined || (this.edge ?? -Infinity) > this.baseline;
    if (this.advances >= 2 && pastBaseline && this.downloaded > this.firstDownloaded) {
      this.verified = true;
    }
  }

  /** The session's first live position, against what the stream's previous session saw. */
  private first(last: number, now: number): void {
    const seed = this.seed;
    const window = this.settings.staleAfterMs / 1000;
    this.own = last;
    if (seed !== undefined && last <= seed.edge && last >= seed.edge - window) {
      // The same window the previous session had: no newer, and its clock goes on.
      this.edge = seed.edge;
      this.edgeSince = seed.since;
      this.baseline = seed.edge;
      return;
    }
    this.edge = last;
    this.edgeSince = now;
    // Newer than the previous session's edge, it still has to get past it by moving. One far
    // behind it (as after the broadcaster's clock jumped back) only has to move by itself.
    this.baseline = seed !== undefined && last > seed.edge ? seed.edge : undefined;
  }

  /** The stat URL did not answer. */
  failed(): void {
    this.polls.failed += 1;
    this.hasNoLivePos ||= this.edge === undefined && this.polls.failed >= this.settings.noLiveAfterPolls;
  }

  state(): LiveEdgeState {
    if (this.edge === undefined) {
      return this.hasNoLivePos ? "none" : "waiting";
    }
    const now = this.now();
    const staleAfterMs = this.settings.staleAfterMs;
    if (now - (this.edgeSince ?? now) > staleAfterMs || this.behindMs() > staleAfterMs) {
      return "stale";
    }
    return this.verified ? "live" : "waiting";
  }

  /** Whether output from the session may be published: it is live, or has no live position at all. */
  publishable(): boolean {
    const state = this.state();
    return state === "live" || state === "none";
  }

  view(): LiveEdgeView {
    return {
      state: this.state(),
      edgeAt: this.edge === undefined ? null : new Date(this.edge * 1000).toISOString(),
      advancedAt: this.edgeSince === undefined ? null : new Date(this.edgeSince).toISOString(),
      behindSeconds: this.edge === undefined || this.pos === undefined ? null : Math.max(0, this.edge - this.pos),
    };
  }

  /** How far behind its live edge the engine serves the stream. */
  private behindMs(): number {
    return this.edge === undefined || this.pos === undefined ? 0 : Math.max(0, this.edge - this.pos) * 1000;
  }
}

/** Reads `livepos` from an engine's stat response; its numbers come as strings. */
export function parseLiveSample(body: unknown): LiveSample | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const response = (body as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  const raw = response as { status?: unknown; downloaded?: unknown; livepos?: unknown };
  const livepos =
    typeof raw.livepos === "object" && raw.livepos !== null
      ? (raw.livepos as { last?: unknown; pos?: unknown })
      : undefined;
  return {
    status: typeof raw.status === "string" ? raw.status : "unknown",
    downloaded: toNumber(raw.downloaded) ?? 0,
    last: toNumber(livepos?.last),
    pos: toNumber(livepos?.pos),
  };
}

function toNumber(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Polls one session's stat URL about once a second (one request at a time) and feeds a `LiveEdge`.
 */
export class LiveEdgeWatch {
  readonly edge: LiveEdge;
  private readonly url: string;
  private readonly fetch: Fetch;
  private readonly timer: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(url: string, edge: LiveEdge, fetchImpl: Fetch = fetch, intervalMs = 1000) {
    this.url = url;
    this.edge = edge;
    this.fetch = fetchImpl;
    this.timer = setInterval(() => {
      void this.poll();
    }, intervalMs);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** A method, so that a check after an `await` sees `stop()` calls made meanwhile. */
  private isStopped(): boolean {
    return this.stopped;
  }

  private async poll(): Promise<void> {
    if (this.busy || this.stopped) {
      return;
    }
    this.busy = true;
    try {
      const response = await this.fetch(this.url, { signal: AbortSignal.timeout(3000) });
      const sample = response.ok ? parseLiveSample(await response.json()) : undefined;
      if (this.isStopped()) {
        return;
      }
      if (sample === undefined) {
        this.edge.failed();
      } else {
        this.edge.observe(sample);
      }
    } catch {
      if (!this.isStopped()) {
        this.edge.failed();
      }
    } finally {
      this.busy = false;
    }
  }
}

/** Starts following a session's live edge; replaceable in tests. */
export type WatchLiveEdge = (statUrl: string, edge: LiveEdge) => { readonly edge: LiveEdge; stop: () => void };

export const watchLiveEdge: WatchLiveEdge = (statUrl, edge) => new LiveEdgeWatch(statUrl, edge);
