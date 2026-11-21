import { STREAM_STATES, type PathStatus, type StreamView, type ViewerView } from "@aceswarm/shared/api-types";
import { Counter, Gauge, Histogram, type Registry } from "@prometheus-io/client";
import type { EngineCount, EngineMemory } from "./engine-resources.ts";
import type { EnginePlace } from "./engine-places.ts";
import { ENGINE_END_REASONS } from "./engine-runs.ts";
import type { SharedEngineView } from "./shared-engines.ts";

/** More sources for the gauges, read at scrape time. */
export interface MetricSources {
  viewers?: () => ViewerView[];
  sharedEngines?: () => SharedEngineView[];
  /** Engines running at the last sample; undefined before the first, or when it could not list them. */
  engines?: () => EngineCount | undefined;
  /** When a stream was last started (see `Orchestrator.runningSince`); undefined while it is disabled. */
  runningSince?: (stream: string) => number | undefined;
  /**
   * The place of each of these engines, in their order (see `EnginePlaces.resolve`): what each is
   * for, and its network path. Without it, the engines' role and path labels are empty.
   */
  enginePlaces?: (engines: readonly EngineMemory[], streams: readonly StreamView[]) => EnginePlace[];
}

/** Both kinds of engines, even when there are none of one, so their sum is there as soon as it is known. */
function setEngineCount(gauge: Gauge<"kind">, source: (() => EngineCount | undefined) | undefined): void {
  gauge.reset();
  const count = source?.();
  if (count === undefined) {
    return;
  }
  gauge.set({ kind: "own" }, count.own);
  gauge.set({ kind: "shared" }, count.shared);
}

function setStandbyGauge(gauge: Gauge<"stream" | "path" | "state">, streams: StreamView[]): void {
  for (const stream of streams) {
    for (const standby of stream.standbys) {
      gauge.set({ stream: stream.id, path: standby.path, state: standby.state }, 1);
    }
  }
}

/**
 * How long ago players could last get a new frame of a stream. A stopped stream keeps that time for
 * the UI, but it isn't expected to have video, so it has no age here. Nor has a stream that was
 * started (`since`) after its last frame: the time it spent disabled, or the stack spent down, is
 * no outage, and would dwarf every other stream's age until its first new frame.
 */
function setFrameAge(gauge: Gauge<"stream">, stream: StreamView, now: number, since = 0): void {
  if (stream.lastFrameAt === null || stream.state === "stopped") {
    return;
  }
  const lastFrameAt = Date.parse(stream.lastFrameAt);
  if (lastFrameAt >= since) {
    gauge.set({ stream: stream.id }, Math.max(0, (now - lastFrameAt) / 1000));
  }
}

/** The countries of the peers sending the stream's engine data, with the engine they are the peers of. */
function setCountries(gauge: Gauge<"stream" | "engine" | "country">, stream: StreamView): void {
  for (const country of stream.peers.countries) {
    gauge.set({ stream: stream.id, engine: stream.engine?.name ?? "", country: country.code }, country.count);
  }
}

/**
 * The live edge of the session a stream plays from: how old its newest data is, since when that
 * session's edge is the same, and for how long the broadcast sent nothing new. The last one is the
 * stream's, not the session's: it goes on when a retry opens a new session, whose own edge starts
 * over (see `LiveEdgeView.quietSince`).
 */
function setLiveEdgeGauges(
  gauges: Record<"age" | "unchanged" | "quiet", Gauge<"stream">>,
  stream: StreamView,
  now: number,
): void {
  const edgeAt = stream.liveEdge?.edgeAt ?? null;
  const advancedAt = stream.liveEdge?.advancedAt ?? null;
  const quietSince = stream.liveEdge?.quietSince ?? null;
  if (edgeAt !== null) {
    gauges.age.set({ stream: stream.id }, (now - Date.parse(edgeAt)) / 1000);
  }
  if (advancedAt !== null) {
    gauges.unchanged.set({ stream: stream.id }, Math.max(0, (now - Date.parse(advancedAt)) / 1000));
  }
  if (quietSince !== null) {
    gauges.quiet.set({ stream: stream.id }, Math.max(0, (now - Date.parse(quietSince)) / 1000));
  }
}

/**
 * The labels of the engine gauges. `engine` is the container's name, which every new engine
 * changes; `role` and `path` say what the engine is for (see `EngineRole`) and stay the same from
 * one engine to the next, so a dashboard that leaves `engine` out draws one line for each place.
 */
const ENGINE_LABELS = ["stream", "engine", "role", "path"] as const;

type EngineGauges = Record<"memory" | "memoryLimit" | "cache" | "cacheLimit", Gauge<(typeof ENGINE_LABELS)[number]>>;

function setEngineGauges(
  gauges: EngineGauges,
  engines: readonly EngineMemory[],
  streams: readonly StreamView[],
  placesOf: MetricSources["enginePlaces"],
): void {
  const places = placesOf?.(engines, streams) ?? [];
  for (const [index, engine] of engines.entries()) {
    const place = places[index];
    const labels = { stream: engine.stream, engine: engine.engine, role: place?.role ?? "", path: place?.path ?? "" };
    gauges.memory.set(labels, engine.usedBytes);
    gauges.memoryLimit.set(labels, engine.limitBytes);
    gauges.cache.set(labels, engine.cacheBytes);
    if (engine.cacheLimitBytes !== null) {
      gauges.cacheLimit.set(labels, engine.cacheLimitBytes);
    }
  }
}

/**
 * Prometheus metrics of the controller. Gauges are filled at scrape time from the current
 * snapshot, so they always match what the UI shows.
 */
export class ControllerMetrics {
  readonly recoveries: Counter<"stream" | "action">;
  readonly recoveriesSucceeded: Counter<"stream" | "action">;
  readonly pathSwitches: Counter<"stream" | "from" | "to">;
  readonly engineStarts: Counter<"stream">;
  readonly engineOomKills: Counter<"stream">;
  readonly sharedEngineRestarts: Counter<"path" | "reason">;
  /** How long each run of an engine lasted, by kind of engine and why it ended (see `EngineRuns`). */
  readonly engineLifetime: Histogram<"kind" | "reason">;

  constructor(
    registry: Registry,
    snapshot: () => { streams: StreamView[]; paths: PathStatus[] },
    engineMemory: () => EngineMemory[] = () => [],
    sources: MetricSources = {},
  ) {
    const registers = [registry];
    this.recoveries = new Counter({
      name: "aceswarm_stream_recoveries_total",
      help: "Recovery steps taken per stream, whether or not they brought video back",
      labelNames: ["stream", "action"],
      registers,
    });
    this.recoveriesSucceeded = new Counter({
      name: "aceswarm_stream_recoveries_succeeded_total",
      help:
        "Recoveries that brought video back: one each time a stream plays again after recovery steps, " +
        "under the last step that changed where it plays from",
      labelNames: ["stream", "action"],
      registers,
    });
    this.pathSwitches = new Counter({
      name: "aceswarm_stream_path_switches_total",
      help: "Network path switches per stream",
      labelNames: ["stream", "from", "to"],
      registers,
    });
    this.engineStarts = new Counter({
      name: "aceswarm_engine_starts_total",
      help: "Engine containers created per stream",
      labelNames: ["stream"],
      registers,
    });
    this.engineOomKills = new Counter({
      name: "aceswarm_engine_oom_kills_total",
      help: "Engines killed for exceeding their memory limit (ENGINE_MEMORY_MB)",
      labelNames: ["stream"],
      registers,
    });

    this.sharedEngineRestarts = new Counter({
      name: "aceswarm_shared_engine_restarts_total",
      help: "Shared engines replaced, per path and reason (watched, failures, all-failed, unresponsive, manual)",
      labelNames: ["path", "reason"],
      registers,
    });
    this.engineLifetime = new Histogram({
      name: "aceswarm_engine_lifetime_seconds",
      help:
        "How long engines ran until they were restarted or removed, per kind of engine (own, shared) " +
        "and reason; an engine that is restarted in its container counts once per run",
      labelNames: ["kind", "reason"],
      // Half a minute to a week: an engine that fails lasts minutes, a healthy one days.
      buckets: [30, 60, 120, 300, 900, 3600, 21_600, 86_400, 604_800],
      registers,
    });
    // From zero, so that the first run that ends for a reason shows as an increase.
    for (const [kind, reasons] of Object.entries(ENGINE_END_REASONS)) {
      for (const reason of reasons) {
        this.engineLifetime.zero({ kind, reason });
      }
    }

    // prom-client calls collect() on every scrape; one gauge refreshes all of them. It is
    // registered before the gauges it fills, because a scrape reads each metric in turn: the ones
    // before it would show the previous scrape's values.
    const total: Gauge = new Gauge({
      name: "aceswarm_streams",
      help: "Number of configured streams",
      registers,
      collect: () => {
        const current = snapshot();
        const liveEdge = [liveEdgeAge, liveEdgeStill, sourceQuiet];
        const gauges = [info, state, up, frameAge, ...liveEdge, peers, countries, speed, path];
        const others = [memory, memoryLimit, viewers, cache, cacheLimit, watching, sharedStreams, sharedStandbys];
        for (const gauge of [...gauges, ...others, standbys]) {
          gauge.reset();
        }
        const now = Date.now();
        for (const stream of current.streams) {
          const labels = { stream: stream.id };
          info.set({ ...labels, name: stream.name, ace_id: stream.aceId, enabled: String(stream.enabled) }, 1);
          for (const candidate of STREAM_STATES) {
            state.set({ ...labels, state: candidate }, candidate === stream.state ? 1 : 0);
          }
          // A disabled stream is not expected to deliver: it has no value, so neither the alert,
          // the dashboard's outages nor its availability count the time it was off. One that is
          // enabled counts from the start, even before its run exists (the controller listens
          // while it is still starting up), as an outage.
          if (stream.enabled) {
            up.set(labels, stream.state === "playing" ? 1 : 0);
          }
          setFrameAge(frameAge, stream, now, sources.runningSince?.(stream.id));
          setLiveEdgeGauges({ age: liveEdgeAge, unchanged: liveEdgeStill, quiet: sourceQuiet }, stream, now);
          if (stream.peers.connected !== null) {
            peers.set({ ...labels, kind: "connected" }, stream.peers.connected);
          }
          if (stream.peers.active !== null) {
            peers.set({ ...labels, kind: "active" }, stream.peers.active);
          }
          if (stream.peers.uploading !== null) {
            peers.set({ ...labels, kind: "uploading" }, stream.peers.uploading);
          }
          setCountries(countries, stream);
          if (stream.downloadKBps !== null) {
            speed.set({ ...labels, direction: "down" }, stream.downloadKBps);
          }
          if (stream.uploadKBps !== null) {
            speed.set({ ...labels, direction: "up" }, stream.uploadKBps);
          }
          if (stream.path !== null) {
            path.set({ ...labels, path: stream.path }, 1);
          }
          viewers.set(labels, stream.viewers);
        }
        setStandbyGauge(standbys, current.streams);
        setEngineCount(engines, sources.engines);
        const watchers = sources.viewers?.() ?? [];
        for (const viewer of watchers) {
          watching.set({ viewer: viewer.viewer, device: viewer.device, stream: viewer.stream }, 1);
        }
        const sharedEngines = sources.sharedEngines?.() ?? [];
        for (const engine of sharedEngines) {
          sharedStreams.set(
            { path: engine.path, engine: engine.engine, retiring: String(engine.retiring) },
            engine.streams,
          );
          sharedStandbys.set({ path: engine.path, engine: engine.engine }, engine.standbys);
        }
        setEngineGauges(
          { memory, memoryLimit, cache, cacheLimit },
          engineMemory(),
          current.streams,
          sources.enginePlaces,
        );
        total.set(current.streams.length);
      },
    });

    const info = new Gauge({
      name: "aceswarm_stream_info",
      help: "Configured streams (value is always 1)",
      labelNames: ["stream", "name", "ace_id", "enabled"],
      registers,
    });
    const state = new Gauge({
      name: "aceswarm_stream_state",
      help: "Current state of each stream (1 for the active state)",
      labelNames: ["stream", "state"],
      registers,
    });
    const up = new Gauge({
      name: "aceswarm_stream_up",
      help: "1 while the stream is playing, 0 while it is enabled and not playing; no value while it is disabled",
      labelNames: ["stream"],
      registers,
    });
    const frameAge = new Gauge({
      name: "aceswarm_stream_last_frame_age_seconds",
      help:
        "Seconds since players could last get a new video frame of the stream; " +
        "none while it is disabled, nor before its first video after it was started",
      labelNames: ["stream"],
      registers,
    });
    const liveEdgeAge = new Gauge({
      name: "aceswarm_stream_live_edge_age_seconds",
      help: "Age of the newest data of the broadcast the stream's engine knows of (livepos.last), by the broadcaster's clock, which can be off",
      labelNames: ["stream"],
      registers,
    });
    const liveEdgeStill = new Gauge({
      name: "aceswarm_stream_live_edge_unchanged_seconds",
      help:
        "Seconds since the live edge of the stream's current engine session last moved or was first seen, by our clock. " +
        "It is the session's: it starts over when a retry opens a session on another window, though the broadcast " +
        "sends nothing new. Past STALE_SOURCE_SECONDS that session is stale. " +
        "For how long the broadcast is quiet, see aceswarm_stream_source_quiet_seconds",
      labelNames: ["stream"],
      registers,
    });
    const sourceQuiet = new Gauge({
      name: "aceswarm_stream_source_quiet_seconds",
      help:
        "Seconds since the stream's broadcast last sent new data, by our clock: since the live edge of a live session " +
        "of the stream last moved (while none was live yet, since its first session saw a live edge). " +
        "It goes on through retries, whose new sessions start their own edge over, and is near 0 while the stream plays. " +
        "No value while the stream's session shows no live position",
      labelNames: ["stream"],
      registers,
    });
    const peers = new Gauge({
      name: "aceswarm_stream_peers",
      help:
        "Peers of the stream (connected: reported by the engine for its session, active: sending the engine stream data, " +
        "uploading: getting stream data from it). Active and uploading are the engine's, which a shared engine's streams share",
      labelNames: ["stream", "kind"],
      registers,
    });
    const countries = new Gauge({
      name: "aceswarm_stream_peer_countries",
      help:
        "Per country, the peers that sent the stream's engine data (its top five countries). Every stream on a shared " +
        "engine reports the engine's: count each engine once",
      labelNames: ["stream", "engine", "country"],
      registers,
    });
    const speed = new Gauge({
      name: "aceswarm_stream_speed_kbytes",
      help: "P2P transfer rate of the stream in KiB/s (1024 bytes per second, as the engine reports it)",
      labelNames: ["stream", "direction"],
      registers,
    });
    const path = new Gauge({
      name: "aceswarm_stream_path",
      help: "Network path used by the stream (value is always 1)",
      labelNames: ["stream", "path"],
      registers,
    });

    const memory = new Gauge({
      name: "aceswarm_engine_memory_bytes",
      help: "Memory used by each engine container, without reclaimable page cache. role and path: what the engine is for",
      labelNames: ENGINE_LABELS,
      registers,
    });
    const memoryLimit = new Gauge({
      name: "aceswarm_engine_memory_limit_bytes",
      help: "Memory limit of each engine container",
      labelNames: ENGINE_LABELS,
      registers,
    });
    const cache = new Gauge({
      name: "aceswarm_engine_memory_cache_bytes",
      help: "Estimated stream data in each engine's memory cache: its memory above an idle engine's, at most the cap; 0 with the cache on disk",
      labelNames: ENGINE_LABELS,
      registers,
    });
    const cacheLimit = new Gauge({
      name: "aceswarm_engine_memory_cache_limit_bytes",
      help: "Memory cache cap of each engine (ENGINE_MEMORY_CACHE_MB when it started); missing when it has none, or keeps its cache on disk",
      labelNames: ENGINE_LABELS,
      registers,
    });

    const viewers = new Gauge({
      name: "aceswarm_stream_viewers",
      help: "Players showing the stream full screen",
      labelNames: ["stream"],
      registers,
    });
    const watching = new Gauge({
      name: "aceswarm_viewer_watching",
      help: "What each player shows full screen (value is always 1). Viewer ids are random and last one visit.",
      labelNames: ["viewer", "device", "stream"],
      registers,
    });
    const sharedStreams = new Gauge({
      name: "aceswarm_shared_engine_streams",
      help: "Streams playing from each shared engine",
      labelNames: ["path", "engine", "retiring"],
      registers,
    });
    const sharedStandbys = new Gauge({
      name: "aceswarm_shared_engine_standbys",
      help: "Streams of other paths with a standby session on each shared engine",
      labelNames: ["path", "engine"],
      registers,
    });
    const standbys = new Gauge({
      name: "aceswarm_stream_standby",
      help: "Each stream's standbys on other paths (value is always 1), by state: starting, warming, hot, failed (also a path that lost its standbys and waits for a new one)",
      labelNames: ["stream", "path", "state"],
      registers,
    });
    const engines = new Gauge({
      name: "aceswarm_engines",
      help: "Engine containers running at the last sample (every ENGINE_STATS_SECONDS), by kind: own (a stream's: the one it plays from, a standby, or one kept to retry a move) and shared (a network path's)",
      labelNames: ["kind"],
      registers,
    });
  }
}
