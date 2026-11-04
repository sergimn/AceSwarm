import type { Service } from "@aceswarm/shared/service";
import { Gauge } from "@prometheus-io/client";
import { z } from "zod";
import type { Gateway } from "./gateway.ts";
import { isIpv4 } from "./ipv4.ts";
import { UnknownPathError } from "./router.ts";

const ipParams = z.object({ ip: z.string().refine(isIpv4, "not an IPv4 address") });
const assignBody = z.object({ path: z.string().min(1).max(64) });

export function registerMetrics(service: Service, gateway: Gateway): void {
  const registers = [service.registry];
  const up = new Gauge({
    name: "aceswarm_path_up",
    help: "1 when the path passes its probes",
    labelNames: ["path"],
    registers,
  });
  const rtt = new Gauge({
    name: "aceswarm_path_rtt_seconds",
    help: "Probe round-trip time",
    labelNames: ["path"],
    registers,
  });
  const loss = new Gauge({
    name: "aceswarm_path_loss_ratio",
    help: "Probe packet loss (0-1)",
    labelNames: ["path"],
    registers,
  });
  const score = new Gauge({
    name: "aceswarm_path_score",
    help: "Path health score (0-1)",
    labelNames: ["path"],
    registers,
  });
  const handshake = new Gauge({
    name: "aceswarm_path_handshake_age_seconds",
    help: "Seconds since the last WireGuard handshake",
    labelNames: ["path"],
    registers,
  });
  const engines = new Gauge({
    name: "aceswarm_path_engines",
    help: "Engines routed through each path",
    labelNames: ["path"],
    registers,
  });
  const peers = new Gauge({
    name: "aceswarm_engine_peers",
    help: "Peers seen in the gateway's connection table per engine",
    labelNames: ["engine_ip", "kind"],
    registers,
  });
  const total: Gauge = new Gauge({
    name: "aceswarm_paths",
    help: "Number of network paths (direct plus tunnels)",
    registers,
    collect: () => {
      for (const gauge of [up, rtt, loss, score, handshake, engines, peers]) {
        gauge.reset();
      }
      const paths = gateway.paths();
      for (const path of paths) {
        const labels = { path: path.id };
        up.set(labels, path.up ? 1 : 0);
        score.set(labels, path.score);
        if (path.rttMs !== null) {
          rtt.set(labels, path.rttMs / 1000);
        }
        if (path.loss !== null) {
          loss.set(labels, path.loss);
        }
        if (path.handshakeAgeSeconds !== null) {
          handshake.set(labels, path.handshakeAgeSeconds);
        }
        engines.set(labels, gateway.router.list().filter((assignment) => assignment.path === path.id).length);
      }
      for (const stats of gateway.peers.all()) {
        peers.set({ engine_ip: stats.ip, kind: "connected" }, stats.connected);
        if (stats.active !== null) {
          peers.set({ engine_ip: stats.ip, kind: "active" }, stats.active);
        }
      }
      total.set(paths.length);
    },
  });
}

export function registerRoutes(service: Service, gateway: Gateway): void {
  const { app } = service;

  app.get("/paths", () => gateway.paths());
  app.get("/assignments", () => gateway.router.list());
  app.get("/peers", () => gateway.peers.all());

  app.post("/reload", async () => {
    await gateway.reload();
    return gateway.paths();
  });

  app.put("/assignments/:ip", async (request, reply) => {
    const params = ipParams.safeParse(request.params);
    const body = assignBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "expected PUT /assignments/<ipv4> with { path }" });
    }
    try {
      await gateway.router.assign(params.data.ip, body.data.path);
    } catch (error) {
      const status = error instanceof UnknownPathError ? 404 : 400;
      return reply.code(status).send({ error: (error as Error).message });
    }
    return { ip: params.data.ip, path: body.data.path };
  });

  app.delete("/assignments/:ip", async (request, reply) => {
    const params = ipParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "expected an IPv4 address" });
    }
    await gateway.router.unassign(params.data.ip);
    return reply.code(204).send();
  });

  app.get("/peers/:ip", async (request, reply) => {
    const params = ipParams.safeParse(request.params);
    return params.success
      ? gateway.peers.get(params.data.ip)
      : reply.code(400).send({ error: "expected an IPv4 address" });
  });
}
