import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import type { PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { Service } from "@aceswarm/shared/service";
import { Counter, Gauge } from "@prometheus-io/client";
import { z } from "zod";
import { Pipeline, VARIANTS, type PipelineSettings, type Spawner, type Variant } from "./pipeline.ts";

const idParams = z.object({ id: z.string().regex(/^[a-z0-9]{6,32}$/) });
const startBody = z.object({ source: z.url({ protocol: /^https?$/ }) });
const startQuery = z.object({ handover: z.enum(["true", "false"]).default("false") });

/** Owns every pipeline and exposes them over HTTP, together with the HLS output. */
export class PipelineManager {
  private readonly pipelines = new Map<string, Pipeline>();
  private readonly settings: PipelineSettings;
  private readonly logger: Logger;
  private readonly spawner: Spawner | undefined;
  readonly generations: Counter<"stream" | "reason">;
  readonly handovers: Counter<"stream" | "result">;

  constructor(service: Service, settings: PipelineSettings, logger: Logger, spawner?: Spawner) {
    this.settings = settings;
    this.logger = logger;
    this.spawner = spawner;
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
    const running = new Gauge({
      name: "aceswarm_pipeline_running",
      help: "1 while the stream's ffmpeg is producing video",
      labelNames: ["stream"],
      registers,
    });
    const fps = new Gauge({
      name: "aceswarm_pipeline_fps",
      help: "Frames per second processed by ffmpeg",
      labelNames: ["stream"],
      registers,
    });
    const lastFrame = new Gauge({
      name: "aceswarm_pipeline_last_frame_timestamp_seconds",
      help: "Unix time of the last video frame of the stream",
      labelNames: ["stream"],
      registers,
    });
    const total: Gauge = new Gauge({
      name: "aceswarm_pipelines",
      help: "Number of pipelines",
      registers,
      collect: () => {
        running.reset();
        fps.reset();
        lastFrame.reset();
        for (const status of this.list()) {
          running.set({ stream: status.id }, status.state === "running" ? 1 : 0);
          if (status.fps !== null) {
            fps.set({ stream: status.id }, status.fps);
          }
          if (status.lastFrameAt !== null) {
            lastFrame.set({ stream: status.id }, Date.parse(status.lastFrameAt) / 1000);
          }
        }
        total.set(this.pipelines.size);
      },
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

  async start(id: string, source: string, handover: boolean): Promise<PipelineStatus> {
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
        },
        this.spawner,
      );
      this.pipelines.set(id, pipeline);
    }
    await pipeline.start(source, handover);
    return pipeline.status();
  }

  async stop(id: string): Promise<boolean> {
    const pipeline = this.pipelines.get(id);
    this.pipelines.delete(id);
    await pipeline?.stop();
    return pipeline !== undefined;
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
      ? manager.start(params.data.id, body.data.source, query.data.handover === "true")
      : reply.code(400).send({ error: "expected /pipelines/:id?handover=bool with { source }" });
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
