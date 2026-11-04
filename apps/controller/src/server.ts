import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import fastifyStatic from "@fastify/static";
import { parseAceId } from "@aceswarm/shared/ace-id";
import { describeError } from "@aceswarm/shared/http";
import type { Service } from "@aceswarm/shared/service";
import { toProfileName } from "@aceswarm/shared/wireguard";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Orchestrator } from "./orchestrator.ts";
import { DuplicateStreamError } from "./stream-store.ts";
import { InvalidProfileError } from "./wireguard-store.ts";

const newStreamSchema = z.object({
  aceId: z.string().min(1).max(300),
  name: z.string().max(80).optional(),
});

const patchStreamSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const profileSchema = z.object({
  name: z.string().min(1).max(64),
  config: z.string().min(1).max(16_384),
});

const idParams = z.object({ id: z.string().regex(/^[a-z0-9]{6,32}$/) });
const nameParams = z.object({ name: z.string().min(1).max(64) });

const HOP_HEADERS = ["content-type", "content-length", "cache-control", "last-modified"];

function badRequest(reply: FastifyReply, error: string, details?: string[]): FastifyReply {
  return reply.code(400).send(details === undefined ? { error } : { error, details });
}

export interface ServerOptions {
  uiDir: string;
  transcoderUrl: string;
  eventIntervalMs?: number;
}

/** Registers the REST API, the live event stream, the HLS proxy and the static UI. */
export async function registerRoutes(
  service: Service,
  orchestrator: Orchestrator,
  options: ServerOptions,
): Promise<FastifyInstance> {
  const { app } = service;

  app.get("/api/snapshot", () => orchestrator.snapshot());
  app.get("/api/streams", () => orchestrator.snapshot().streams);

  app.post("/api/streams", async (request, reply) => {
    const parsed = newStreamSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, "expected { aceId, name? }");
    }
    const ace = parseAceId(parsed.data.aceId);
    if (ace === undefined) {
      return badRequest(
        reply,
        "that does not look like an Acestream ID or infohash (40 hex characters, an acestream:// or a magnet link)",
      );
    }
    try {
      const stream = await orchestrator.addStream({ aceId: ace.id, aceIdKind: ace.kind, name: parsed.data.name });
      return await reply.code(201).send(stream);
    } catch (error) {
      if (error instanceof DuplicateStreamError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch("/api/streams/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = patchStreamSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return badRequest(reply, "expected { name?, enabled? }");
    }
    const patch: { name?: string; enabled?: boolean } = {};
    if (body.data.name !== undefined) {
      patch.name = body.data.name;
    }
    if (body.data.enabled !== undefined) {
      patch.enabled = body.data.enabled;
    }
    const stream = await orchestrator.updateStream(params.data.id, patch);
    return stream ?? reply.code(404).send({ error: "stream not found" });
  });

  app.delete("/api/streams/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    return params.success && (await orchestrator.removeStream(params.data.id))
      ? reply.code(204).send()
      : reply.code(404).send({ error: "stream not found" });
  });

  app.post("/api/streams/:id/restart", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    return params.success && orchestrator.restartStream(params.data.id)
      ? reply.code(202).send({ status: "restarting" })
      : reply.code(404).send({ error: "stream not running" });
  });

  app.get("/api/paths", () => orchestrator.snapshot().paths);
  app.get("/api/wireguard", () => orchestrator.listProfiles());

  app.post("/api/wireguard", async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, "expected { name, config }");
    }
    try {
      const profile = await orchestrator.saveProfile(toProfileName(parsed.data.name), parsed.data.config);
      return await reply.code(201).send(profile);
    } catch (error) {
      if (error instanceof InvalidProfileError) {
        return badRequest(reply, "invalid WireGuard profile", error.problems);
      }
      throw error;
    }
  });

  app.delete("/api/wireguard/:name", async (request, reply) => {
    const params = nameParams.safeParse(request.params);
    return params.success && (await orchestrator.removeProfile(params.data.name))
      ? reply.code(204).send()
      : reply.code(404).send({ error: "profile not found" });
  });

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (): void => {
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(orchestrator.snapshot())}\n\n`);
    };
    send();
    const timer = setInterval(send, options.eventIntervalMs ?? 2000);
    request.raw.on("close", () => {
      clearInterval(timer);
    });
  });

  // HLS playlists and segments come from the transcoder; proxying keeps a single origin for the
  // browser and avoids exposing the transcoder.
  app.get("/hls/*", async (request, reply) => {
    let upstream: Response;
    try {
      upstream = await fetch(`${options.transcoderUrl}${request.url}`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return reply.code(502).send({ error: describeError(error) });
    }
    reply.code(upstream.status);
    for (const header of HOP_HEADERS) {
      const value = upstream.headers.get(header);
      if (value !== null) {
        reply.header(header, value);
      }
    }
    return upstream.body === null
      ? reply.send()
      : reply.send(Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>));
  });

  if (existsSync(options.uiDir)) {
    await app.register(fastifyStatic, { root: options.uiDir, prefix: "/" });
  } else {
    app.log.warn({ uiDir: options.uiDir }, "UI build not found; only the API is served");
  }

  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, "request failed");
    void reply.code(500).send({ error: describeError(error) });
  });

  return app;
}
