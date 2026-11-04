import { spawn } from "node:child_process";
import type { Service } from "@aceswarm/shared/service";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { behaviorFor, buildSourceArgs, hueFor, type SourcePlan } from "./behavior.ts";
import type { PeerPinger } from "./peers.ts";
import type { Session, SessionStore } from "./sessions.ts";

export interface MockOptions {
  ffmpegPath: string;
  videoSize: string;
  fps: number;
  loadDelayMs: number;
  stallAfterMs: number;
  /** How long `getstream` waits for a VPN peer when the stream needs one. */
  peerWaitMs: number;
}

const getstreamQuery = z.object({
  id: z.string().optional(),
  content_id: z.string().optional(),
  format: z.string().optional(),
  pid: z.string().max(128).optional(),
});

const sessionParams = z.object({ session: z.string().regex(/^[0-9a-f]{32}$/) });

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Envelope {
  response: unknown;
  error: string | null;
}

const ok = (response: unknown): Envelope => ({ response, error: null });
const failure = (error: string): Envelope => ({ response: null, error });

async function waitForVpnPeer(pinger: PeerPinger, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pinger.vpnReachable() === 0) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(250);
  }
  return true;
}

/** Peers to report: real replies when mock peers are configured, otherwise a plausible number. */
function peerCount(session: Session, pinger: PeerPinger): number {
  return pinger.configured ? pinger.reachable() : 4 + (hueFor(session.contentId) % 9);
}

/**
 * Registers a fake Acestream engine API: version, `getstream` (JSON format), the playback stream,
 * statistics and the stop command. Playback is a synthetic MPEG-TS stream produced by ffmpeg.
 */
export function registerRoutes(
  service: Service,
  sessions: SessionStore,
  pinger: PeerPinger,
  options: MockOptions,
): void {
  const { app } = service;

  app.get("/webui/api/service", (request, reply) => {
    const { method } = request.query as { method?: string };
    return method === "get_version"
      ? { result: { platform: "linux", version: "3.2.11-mock", code: 3_021_100, websocket_port: 0 }, error: null }
      : reply.code(400).send({ result: null, error: "unknown method" });
  });

  app.get("/ace/getstream", async (request) => {
    const query = getstreamQuery.safeParse(request.query);
    const contentId = (query.data?.id ?? query.data?.content_id ?? "").toLowerCase();
    if (!query.success || !/^[0-9a-f]{40}$/.test(contentId)) {
      return failure("invalid content id");
    }
    const behavior = behaviorFor(contentId);
    await sleep(options.loadDelayMs);
    if (behavior === "dead") {
      return failure("failed to load content");
    }
    if (behavior === "vpn-only" && !(await waitForVpnPeer(pinger, options.peerWaitMs))) {
      return failure("failed to load content");
    }
    const session = sessions.create(contentId, query.data.pid ?? "default", behavior);
    const base = `http://${request.headers.host ?? "localhost:6878"}/ace`;
    return ok({
      playback_url: `${base}/r/${session.id}`,
      stat_url: `${base}/stat/${session.id}`,
      command_url: `${base}/cmd/${session.id}`,
      infohash: contentId,
      playback_session_id: session.id,
      is_live: 1,
      is_encrypted: 0,
    });
  });

  app.get("/ace/stat/:session", (request) => {
    const params = sessionParams.safeParse(request.params);
    const session = params.success ? sessions.get(params.data.session) : undefined;
    return session === undefined
      ? failure("unknown playback session id")
      : ok(sessions.stats(session, peerCount(session, pinger)));
  });

  app.get("/ace/cmd/:session", (request) => {
    const params = sessionParams.safeParse(request.params);
    const { method } = request.query as { method?: string };
    if (!params.success || method !== "stop") {
      return failure("unknown command");
    }
    return sessions.stop(params.data.session) ? ok("ok") : failure("unknown playback session id");
  });

  app.get("/ace/r/:session", (request, reply) => {
    const params = sessionParams.safeParse(request.params);
    const session = params.success ? sessions.get(params.data.session) : undefined;
    if (session === undefined) {
      return reply.code(404).send({ error: "unknown playback session id" });
    }
    play(session, reply, sessions, pinger, options);
    return reply;
  });
}

function play(
  session: Session,
  reply: FastifyReply,
  sessions: SessionStore,
  pinger: PeerPinger,
  options: MockOptions,
): void {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-cache" });
  const plan: SourcePlan = {
    size: options.videoSize,
    fps: options.fps,
    hue: hueFor(session.contentId),
    codec: session.behavior === "mpeg2" ? "mpeg2" : "h264",
  };
  const child = spawn(options.ffmpegPath, buildSourceArgs(plan), { stdio: ["ignore", "pipe", "pipe"] });
  const timers: NodeJS.Timeout[] = [];
  let finished = false;

  const cleanup = (): void => {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    child.kill("SIGKILL");
  };
  // A stalled source stops sending data but keeps the connection open, like a real swarm.
  const stall = (): void => {
    session.stalled = true;
    cleanup();
  };
  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    cleanup();
    response.end();
  };

  child.stdout.on("data", (chunk: Buffer) => {
    sessions.addBytes(session, chunk.length);
  });
  child.stdout.pipe(response, { end: false });
  child.stderr.resume();
  child.on("exit", () => {
    if (!session.stalled) {
      finish();
    }
  });
  child.on("error", finish);
  response.on("close", () => {
    finished = true;
    cleanup();
  });
  session.onStop = finish;

  if (session.behavior === "stall") {
    timers.push(setTimeout(stall, options.stallAfterMs));
  } else if (session.behavior === "vpn-only") {
    timers.push(
      setInterval(() => {
        if (pinger.vpnReachable() === 0) {
          stall();
        }
      }, 1000),
    );
  }
}
