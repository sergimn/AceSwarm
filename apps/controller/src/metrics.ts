import { STREAM_STATES, type PathStatus, type StreamView } from "@aceswarm/shared/api-types";
import { Counter, Gauge, type Registry } from "@prometheus-io/client";

/**
 * Prometheus metrics of the controller. Gauges are filled at scrape time from the current
 * snapshot, so they always match what the UI shows.
 */
export class ControllerMetrics {
  readonly recoveries: Counter<"stream" | "action">;
  readonly pathSwitches: Counter<"stream" | "from" | "to">;
  readonly engineStarts: Counter<"stream">;

  constructor(registry: Registry, snapshot: () => { streams: StreamView[]; paths: PathStatus[] }) {
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

    // prom-client calls collect() on every scrape; one gauge refreshes all of them.
    const total: Gauge = new Gauge({
      name: "aceswarm_streams",
      help: "Number of configured streams",
      registers,
      collect: () => {
        const current = snapshot();
        for (const gauge of [info, state, up, frameAge, peers, countries, speed, path]) {
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
        }
        total.set(current.streams.length);
      },
    });
  }
}
