import { STREAM_STATES, type PathStatus, type StreamView, type ViewerView } from "@aceswarm/shared/api-types";
import { Counter, Gauge, type Registry } from "@prometheus-io/client";
import type { EngineCount, EngineMemory } from "./engine-resources.ts";
import type { SharedEngineView } from "./shared-engines.ts";

/** More sources for the gauges, read at scrape time. */
export interface MetricSources {
  viewers?: () => ViewerView[];
  sharedEngines?: () => SharedEngineView[];
  /** Engines running at the last sample; undefined before the first, or when it could not list them. */
  engines?: () => EngineCount | undefined;
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
 * Prometheus metrics of the controller. Gauges are filled at scrape time from the current
 * snapshot, so they always match what the UI shows.
 */
export class ControllerMetrics {
  readonly recoveries: Counter<"stream" | "action">;
  readonly pathSwitches: Counter<"stream" | "from" | "to">;
  readonly engineStarts: Counter<"stream">;
  readonly engineOomKills: Counter<"stream">;
  readonly sharedEngineRestarts: Counter<"path" | "reason">;

  constructor(
    registry: Registry,
    snapshot: () => { streams: StreamView[]; paths: PathStatus[] },
    engineMemory: () => EngineMemory[] = () => [],
    sources: MetricSources = {},
  ) {
    const registers = [registry];
    this.recoveries = new Counter({
      name: "aceswarm_stream_recoveries_total",
      help: "Recovery actions taken per stream",
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

    // prom-client calls collect() on every scrape; one gauge refreshes all of them. It is
    // registered before the gauges it fills, because a scrape reads each metric in turn: the ones
    // before it would show the previous scrape's values.
    const total: Gauge = new Gauge({
      name: "aceswarm_streams",
      help: "Number of configured streams",
      registers,
      collect: () => {
        const current = snapshot();
        const gauges = [info, state, up, frameAge, peers, countries, speed, path, memory, memoryLimit, viewers];
        for (const gauge of [...gauges, watching, sharedStreams, sharedStandbys, standbys]) {
          gauge.reset();
        }
        const now = Date.now();
        for (const stream of current.streams) {
          const labels = { stream: stream.id };
          info.set({ ...labels, name: stream.name, ace_id: stream.aceId, enabled: String(stream.enabled) }, 1);
          for (const candidate of STREAM_STATES) {
            state.set({ ...labels, state: candidate }, candidate === stream.state ? 1 : 0);
          }
          up.set(labels, stream.state === "playing" ? 1 : 0);
          if (stream.lastFrameAt !== null) {
            frameAge.set(labels, Math.max(0, (now - Date.parse(stream.lastFrameAt)) / 1000));
          }
          if (stream.peers.connected !== null) {
            peers.set({ ...labels, kind: "connected" }, stream.peers.connected);
          }
          if (stream.peers.active !== null) {
            peers.set({ ...labels, kind: "active" }, stream.peers.active);
          }
          for (const country of stream.peers.countries) {
            countries.set({ ...labels, country: country.code }, country.count);
          }
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
        for (const engine of engineMemory()) {
          const labels = { stream: engine.stream, engine: engine.engine };
          memory.set(labels, engine.usedBytes);
          memoryLimit.set(labels, engine.limitBytes);
        }
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
      help: "1 while the stream is playing, 0 otherwise",
      labelNames: ["stream"],
      registers,
    });
    const frameAge = new Gauge({
      name: "aceswarm_stream_last_frame_age_seconds",
      help: "Seconds since the stream produced its last video frame",
      labelNames: ["stream"],
      registers,
    });
    const peers = new Gauge({
      name: "aceswarm_stream_peers",
      help: "Peers of the stream (connected: reported by the engine, active: sending data)",
      labelNames: ["stream", "kind"],
      registers,
    });
    const countries = new Gauge({
      name: "aceswarm_stream_peer_countries",
      help: "Peers of the stream per country (top countries only)",
      labelNames: ["stream", "country"],
      registers,
    });
    const speed = new Gauge({
      name: "aceswarm_stream_speed_kbytes",
      help: "P2P transfer rate of the stream in KB/s",
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
      help: "Memory used by each engine container, without reclaimable page cache",
      labelNames: ["stream", "engine"],
      registers,
    });
    const memoryLimit = new Gauge({
      name: "aceswarm_engine_memory_limit_bytes",
      help: "Memory limit of each engine container",
      labelNames: ["stream", "engine"],
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
      help: "Each stream's standbys on other paths (value is always 1), by state: starting, warming, hot, failed",
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
