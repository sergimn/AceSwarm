import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import type { PipelineStatus, StandbyReaderStatus, StandbySource } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import type { Service } from "@aceswarm/shared/service";
import { Counter, Gauge, Histogram } from "@prometheus-io/client";
import { z } from "zod";
import { FULL_MODES } from "./ffmpeg-args.ts";
import { DECODINGS } from "./key-frames.ts";
import { watchLiveEdge, type WatchLiveEdge } from "./live-edge.ts";
import { Pipeline, VARIANTS, type PipelineSettings, type Spawner, type Variant } from "./pipeline.ts";
import type { OpenSource } from "./source-reader.ts";
import { LAYOUT_CHANGE_KINDS } from "./ts-tables.ts";
import { StandbyReaders, type StandbyReaderSettings } from "./standby-readers.ts";
import { createDecodeChecker, DEFAULT_DECODE_CHECK_SETTINGS, type DecodeChecker } from "./decode-check.ts";

const idParams = z.object({ id: z.string().regex(/^[a-z0-9]{6,32}$/) });
const httpUrl = z.url({ protocol: /^https?$/ });
const startBody = z.object({ source: httpUrl, stat: httpUrl.optional() });
const startQuery = z.object({ handover: z.enum(["true", "false"]).default("false") });
/** A stream has a standby on at most a few other paths; the limit only guards against mistakes. */
const standbySource = z.union([httpUrl, z.object({ source: httpUrl, stat: httpUrl.optional() })]);
const standbysBody = z.object({ sources: z.array(standbySource).max(16) });
/** How many times the pipeline opens a source again that a standby reader just let go of (see `start`). */
const REOPENS_AFTER_RELEASE = 5;

/**
 * Owns every pipeline and exposes them over HTTP, together with the HLS output. It also reads the
 * stream's standby sessions on other paths (see `StandbyReaders`), so they stay hot.
 */
export class PipelineManager {
  private readonly pipelines = new Map<string, Pipeline>();
  /**
   * Streams whose pipeline is still stopping. It removes the stream's files as its last step, and
   * a new pipeline of the stream writes to the same place: that one starts after it.
   */
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly standbys = new Map<string, StandbyReaders>();
  private readonly settings: PipelineSettings;
  private readonly logger: Logger;
  private readonly spawner: Spawner | undefined;
  private readonly standbySettings: StandbyReaderSettings | undefined;
  private readonly watchLiveEdge: WatchLiveEdge;
  private readonly openSource: OpenSource | undefined;
  /** Shared by every stream's standby readers, so that few decode checks run at once. */
  private readonly decoder: DecodeChecker;
  readonly generations: Counter<"stream" | "reason">;
  readonly handovers: Counter<"stream" | "result">;
  readonly layoutChanges: Counter<"stream" | "kind" | "run">;
  readonly layoutGaps: Histogram<"stream">;

  constructor(
    service: Service,
    settings: PipelineSettings,
    logger: Logger,
    spawner?: Spawner,
    standbySettings?: StandbyReaderSettings,
    options: { watchLiveEdge?: WatchLiveEdge; decoder?: DecodeChecker; openSource?: OpenSource } = {},
  ) {
    this.settings = settings;
    this.logger = logger;
    this.spawner = spawner;
    this.standbySettings = standbySettings;
    this.watchLiveEdge = options.watchLiveEdge ?? watchLiveEdge;
    this.openSource = options.openSource;
    this.decoder =
      options.decoder ??
      createDecodeChecker(
        { ...DEFAULT_DECODE_CHECK_SETTINGS, ffmpegPath: settings.ffmpegPath },
        {
          onCannotStart: (error) => {
            logger.warn({ error: describeError(error) }, "ffmpeg can't start, so no standby's video is checked");
          },
        },
      );
    const registers = [service.registry];
    this.generations = new Counter({
      name: "aceswarm_pipeline_starts_total",
      help: "ffmpeg runs started per stream, by reason",
      labelNames: ["stream", "reason"],
      registers,
    });
    this.handovers = new Counter({
      name: "aceswarm_pipeline_handovers_total",
      help: "Make-before-break handovers per stream, by result",
      labelNames: ["stream", "result"],
      registers,
    });
    this.layoutChanges = new Counter({
      name: "aceswarm_pipeline_layout_changes_total",
      help:
        "Changes of the layout of the stream's broadcast that its ffmpeg followed mid-stream, by kind (codec: " +
        "the video's codec changed; pid: the video moved to another PID; other: something else ffmpeg reads, " +
        "such as the sound) and by run (new: a new ffmpeg run took over; same: the same run reads on over a " +
        "move to other PIDs). Tables that change around the streams ffmpeg reads don't count",
      labelNames: ["stream", "kind", "run"],
      registers,
    });
    this.layoutGaps = new Histogram({
      name: "aceswarm_pipeline_layout_change_gap_seconds",
      help:
        "At each layout change of the stream's broadcast that its ffmpeg followed, how long players got no new " +
        "video frame: from the last one before it to the first one after it, once that came. ffmpeg tells of " +
        "its frames once a second, so a change without a pause shows about 1 second",
      labelNames: ["stream"],
      // A move the same run reads on over takes a second or two, a new run a few seconds, a change
      // in the middle of a group of pictures up to two key frame intervals.
      buckets: [0.5, 1, 1.5, 2, 3, 5, 8, 13, 20, 30, 60],
      registers,
    });
    // The client calls collect() on every scrape; one gauge refreshes all of them. It is registered
    // before the gauges it fills, because a scrape reads each metric in turn: the ones before it
    // would show the previous scrape's values.
    const total: Gauge = new Gauge({
      name: "aceswarm_pipelines",
      help: "Number of pipelines",
      registers,
      collect: () => {
        running.reset();
        fps.reset();
        lastFrame.reset();
        decoding.reset();
        fullMode.reset();
        videoCodec.reset();
        standbyReaders.reset();
        for (const [stream, readers] of this.standbys) {
          for (const reader of readers.status()) {
            standbyReaders.inc({ stream, state: reader.state });
          }
        }
        for (const status of this.list()) {
          running.set({ stream: status.id }, status.state === "running" ? 1 : 0);
          if (status.fps !== null) {
            fps.set({ stream: status.id }, status.fps);
          }
          if (status.lastFrameAt !== null) {
            lastFrame.set({ stream: status.id }, Date.parse(status.lastFrameAt) / 1000);
          }
        }
        for (const [stream, pipeline] of this.pipelines) {
          // A stream before its first run has none of these.
          const current = pipeline.decoding();
          if (current === undefined) {
            continue;
          }
          for (const candidate of DECODINGS) {
            decoding.set({ stream, decoding: candidate }, candidate === current ? 1 : 0);
          }
          const { mode, videoCodec: codec } = pipeline.status();
          for (const candidate of FULL_MODES) {
            fullMode.set({ stream, mode: candidate }, candidate === mode ? 1 : 0);
          }
          if (codec !== null) {
            videoCodec.set({ stream, codec }, 1);
          }
        }
        total.set(this.pipelines.size);
      },
    });
    const running = new Gauge({
      name: "aceswarm_pipeline_running",
      help: "1 while the stream's ffmpeg is producing video",
      labelNames: ["stream"],
      registers,
    });
    const fps = new Gauge({
      name: "aceswarm_pipeline_fps",
      help:
        "Frames per second the stream's ffmpeg processes, as it reports it: its average since it started. " +
        "No value while no ffmpeg runs for the stream",
      labelNames: ["stream"],
      registers,
    });
    const lastFrame = new Gauge({
      name: "aceswarm_pipeline_last_frame_timestamp_seconds",
      help: "Unix time of the last video frame of the stream that players could get",
      labelNames: ["stream"],
      registers,
    });
    const decoding = new Gauge({
      name: "aceswarm_pipeline_decoding",
      help:
        "How the stream's ffmpeg run decodes the broadcast, or its last run while none runs (1 for that way, 0 for the others): " +
        "key-frames (key frames only, which gave a frame), key-frames-waiting (key frames only, no frame yet), " +
        "all-frames-fallback (every frame, because key frames only gave none in time, as for a broadcast without IDR frames), " +
        "all-frames (every frame, as PREVIEW_MODE=video, or a re-encoded full stream, need). " +
        "No value before its first run",
      labelNames: ["stream", "decoding"],
      registers,
    });
    const fullMode = new Gauge({
      name: "aceswarm_pipeline_full_mode",
      help:
        "What the stream's ffmpeg run does with the video of the full screen output, or its last run while none " +
        "runs (1 for that mode, 0 for the other): copy (H.264, passed on as it is) or transcode (re-encoded to " +
        "H.264). No value before its first run",
      labelNames: ["stream", "mode"],
      registers,
    });
    const videoCodec = new Gauge({
      name: "aceswarm_pipeline_video_codec",
      help:
        "The codec of the video of the stream's source, as ffmpeg names it (1 for the current one only): what " +
        "ffmpeg found, or else what the source's program tables say. No value before its first run, or while " +
        "neither tells",
      labelNames: ["stream", "codec"],
      registers,
    });
    const standbyReaders = new Gauge({
      name: "aceswarm_standby_readers",
      help: "Standby sessions on other paths the transcoder reads to keep them hot, by state",
      labelNames: ["stream", "state"],
      registers,
    });
  }

  list(): PipelineStatus[] {
    return this.pipelines
      .values()
      .map((pipeline) => pipeline.status())
      .toArray();
  }

  get(id: string): Pipeline | undefined {
    return this.pipelines.get(id);
  }

  async start(id: string, source: string, handover: boolean, stat?: string): Promise<PipelineStatus> {
    await this.stopping.get(id);
    let pipeline = this.pipelines.get(id);
    if (pipeline === undefined) {
      pipeline = new Pipeline(
        id,
        this.settings,
        this.logger,
        {
          generationStarted: (stream, reason) => {
            this.generations.inc({ stream, reason });
          },
          handover: (stream, result) => {
            this.handovers.inc({ stream, result });
          },
          layoutChanged: (stream, kind, run) => {
            this.layoutChanges.inc({ stream, kind, run });
          },
          layoutGap: (stream, ms) => {
            this.layoutGaps.observe({ stream }, ms / 1000);
          },
        },
        { spawner: this.spawner, watchLiveEdge: this.watchLiveEdge, openSource: this.openSource },
      );
      this.pipelines.set(id, pipeline);
      // Every series of the stream starts at 0: Prometheus sees no increase in one that first comes with a value.
      for (const kind of LAYOUT_CHANGE_KINDS) {
        for (const run of ["new", "same"] as const) {
          this.layoutChanges.inc({ stream: id, kind, run }, 0);
        }
      }
      this.layoutGaps.zero({ stream: id });
    }
    // A standby that becomes the source: the pipeline reads it from now on, for ffmpeg, and the
    // engine allows one reader per session. Right after the standby's reader lets go, the engine
    // may still refuse a new one for a moment, so the pipeline opens the source again if its run
    // fails before any video.
    const released = (await this.standbys.get(id)?.release(source)) ?? false;
    await pipeline.start(source, handover, released ? REOPENS_AFTER_RELEASE : 0, stat);
    return pipeline.status();
  }

  /**
   * Reads exactly these standby sources of the stream from now on, leaving out any that ffmpeg
   * reads. Returns undefined when the stream has no pipeline.
   */
  setStandbys(id: string, sources: readonly (string | StandbySource)[]): StandbyReaderStatus[] | undefined {
    const pipeline = this.pipelines.get(id);
    if (pipeline === undefined) {
      return undefined;
    }
    const status = pipeline.status();
    const wanted = sources
      .map((source) => (typeof source === "string" ? { source } : source))
      .filter(({ source }) => source !== status.source && source !== status.pendingSource);
    let readers = this.standbys.get(id);
    if (readers === undefined) {
      if (wanted.length === 0) {
        return [];
      }
      readers = new StandbyReaders(
        this.logger.child({ stream: id }),
        this.standbySettings,
        fetch,
        Date.now,
        { watch: this.watchLiveEdge, liveEdge: this.settings.liveEdge },
        this.decoder,
      );
      this.standbys.set(id, readers);
    }
    const result = readers.set(wanted);
    if (readers.size === 0) {
      this.standbys.delete(id);
    }
    return result;
  }

  standbyStatus(id: string): StandbyReaderStatus[] | undefined {
    return this.pipelines.has(id) ? (this.standbys.get(id)?.status() ?? []) : undefined;
  }

  async stop(id: string): Promise<boolean> {
    const pipeline = this.pipelines.get(id);
    this.pipelines.delete(id);
    this.standbys.get(id)?.closeAll();
    this.standbys.delete(id);
    if (pipeline === undefined) {
      return false;
    }
    const stopped = pipeline.stop().finally(() => {
      if (this.stopping.get(id) === stopped) {
        this.stopping.delete(id);
      }
    });
    this.stopping.set(id, stopped);
    await stopped;
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.pipelines.keys().map((id) => this.stop(id)));
  }

  /** Removes output left behind by a previous run (the HLS directory is a tmpfs volume). */
  async clean(): Promise<void> {
    await rm(this.settings.hlsDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerRoutes(service: Service, manager: PipelineManager): void {
  const { app } = service;

  app.get("/pipelines", () => manager.list());

  app.get("/pipelines/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const pipeline = params.success ? manager.get(params.data.id) : undefined;
    return pipeline === undefined ? reply.code(404).send({ error: "pipeline not found" }) : pipeline.status();
  });

  app.put("/pipelines/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = startBody.safeParse(request.body);
    const query = startQuery.safeParse(request.query);
    return params.success && body.success && query.success
      ? manager.start(params.data.id, body.data.source, query.data.handover === "true", body.data.stat)
      : reply.code(400).send({ error: "expected /pipelines/:id?handover=bool with { source, stat? }" });
  });

  app.get("/standbys/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const status = params.success ? manager.standbyStatus(params.data.id) : undefined;
    return status ?? reply.code(404).send({ error: "pipeline not found" });
  });

  app.put("/standbys/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = standbysBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "expected /standbys/:id with { sources }" });
    }
    return (
      manager.setStandbys(params.data.id, body.data.sources) ?? reply.code(404).send({ error: "pipeline not found" })
    );
  });

  app.delete("/pipelines/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    return params.success && (await manager.stop(params.data.id))
      ? reply.code(204).send()
      : reply.code(404).send({ error: "pipeline not found" });
  });

  app.get("/hls/:id/:variant/index.m3u8", async (request, reply) => {
    const { id, variant } = request.params as { id: string; variant: string };
    const pipeline = manager.get(id);
    if (pipeline === undefined || !VARIANTS.includes(variant as Variant)) {
      return reply.code(404).send({ error: "no such stream" });
    }
    const playlist = await pipeline.playlist(variant as Variant);
    if (playlist === undefined) {
      return reply.code(404).send({ error: "no segments yet" });
    }
    return reply
      .header("content-type", "application/vnd.apple.mpegurl")
      .header("cache-control", "no-cache")
      .send(playlist);
  });

  app.get("/hls/:id/thumbnail.jpg", async (request, reply) => {
    const { id } = request.params as { id: string };
    const path = manager.get(id)?.thumbnailPath();
    return path === undefined
      ? reply.code(404).send({ error: "no thumbnail yet" })
      : reply.header("content-type", "image/jpeg").header("cache-control", "no-cache").send(createReadStream(path));
  });

  app.get("/hls/:id/:generation/:variant/:file", async (request, reply) => {
    const { id = "", generation = "", variant = "", file = "" } = request.params as Partial<Record<string, string>>;
    const path = manager.get(id)?.segmentPath(generation, variant, file);
    if (path === undefined) {
      return reply.code(404).send({ error: "segment not found" });
    }
    return reply
      .header("content-type", "video/mp2t")
      .header("cache-control", "max-age=60")
      .send(createReadStream(path));
  });
}
