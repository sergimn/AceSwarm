import type { PathAssignment, PathStatus, PeerStats } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { createService, type Service } from "@aceswarm/shared/service";
import { beforeEach, describe, expect, test } from "vitest";
import type { Gateway } from "../src/gateway.ts";
import { registerMetrics } from "../src/server.ts";

const logger = createLogger("test", "silent");

function path(id: string, overrides: Partial<PathStatus> = {}): PathStatus {
  return {
    id,
    kind: id === "direct" ? "direct" : "wireguard",
    label: id,
    up: true,
    rttMs: 20,
    loss: 0,
    handshakeAgeSeconds: null,
    score: 1,
    lastProbeAt: null,
    error: null,
    ...overrides,
  };
}

function peers(ip: string, connected: number, active: number | null, uploading: number | null): PeerStats {
  return { ip, connected, active, uploading, countries: [], updatedAt: "2026-11-19T12:00:00.000Z" };
}

describe("the network gateway's metrics", () => {
  let service: Service;
  /** What the fake gateway answers, which a test changes between scrapes. */
  let paths: PathStatus[];
  let assignments: PathAssignment[];
  let peerStats: PeerStats[];
  let wireguardOnly: boolean;

  beforeEach(() => {
    paths = [path("direct")];
    assignments = [];
    peerStats = [];
    wireguardOnly = false;
    const gateway = {
      paths: () => paths,
      policy: () => ({ wireguardOnly }),
      router: { list: () => assignments },
      peers: { all: () => peerStats },
    } as unknown as Gateway;
    service = createService({ name: "test", logger });
    registerMetrics(service, gateway);
  });

  /** One scrape: what Prometheus gets when it asks once. Each series by its name and labels, without the service label. */
  async function scrape(): Promise<Record<string, number>> {
    const text = await service.registry.metrics();
    const found: Record<string, number> = {};
    for (const [, name = "", labels = "", value = ""] of text.matchAll(/^(aceswarm_\w+)(?:\{([^}]*)\})? (\S+)$/gm)) {
      const own = labels
        .split(",")
        .filter((label) => label !== "" && !label.startsWith("service="))
        .toSorted((a, b) => a.localeCompare(b))
        .join(",");
      found[own === "" ? name : `${name}{${own}}`] = Number(value);
    }
    return found;
  }

  test("shows the paths, engines and peers as they are at the one scrape, the very first one included", async () => {
    paths = [
      path("direct", { rttMs: 12, loss: 0.01, score: 0.98 }),
      path("wg:vpn", { rttMs: 40, loss: 0.1, handshakeAgeSeconds: 30, score: 0.6 }),
    ];
    assignments = [
      { ip: "172.31.250.130", path: "wg:vpn" },
      { ip: "172.31.250.131", path: "wg:vpn" },
      { ip: "172.31.250.132", path: "direct" },
    ];
    peerStats = [peers("172.31.250.130", 20, 8, 3)];
    // A gauge that showed what the scrape before it collected would have nothing here.
    expect(await scrape()).toMatchObject({
      aceswarm_paths: 2,
      'aceswarm_path_up{path="direct"}': 1,
      'aceswarm_path_up{path="wg:vpn"}': 1,
      'aceswarm_path_rtt_seconds{path="direct"}': 0.012,
      'aceswarm_path_rtt_seconds{path="wg:vpn"}': 0.04,
      'aceswarm_path_loss_ratio{path="direct"}': 0.01,
      'aceswarm_path_loss_ratio{path="wg:vpn"}': 0.1,
      'aceswarm_path_score{path="direct"}': 0.98,
      'aceswarm_path_score{path="wg:vpn"}': 0.6,
      'aceswarm_path_handshake_age_seconds{path="wg:vpn"}': 30,
      'aceswarm_path_engines{path="direct"}': 1,
      'aceswarm_path_engines{path="wg:vpn"}': 2,
      'aceswarm_engine_peers{engine_ip="172.31.250.130",kind="connected"}': 20,
      'aceswarm_engine_peers{engine_ip="172.31.250.130",kind="active"}': 8,
      'aceswarm_engine_peers{engine_ip="172.31.250.130",kind="uploading"}': 3,
    });
  });

  test("each change shows on the one scrape that follows it, and what went away is gone at once", async () => {
    paths = [path("direct"), path("wg:vpn", { handshakeAgeSeconds: 30 })];
    assignments = [{ ip: "172.31.250.130", path: "wg:vpn" }];
    peerStats = [peers("172.31.250.130", 20, 8, 3)];
    await scrape();

    // The tunnel goes down and loses its probe results, its engine moves, a second engine appears
    // with peers, and the first one's peers change.
    paths = [
      path("direct"),
      path("wg:vpn", { up: false, rttMs: null, loss: null, handshakeAgeSeconds: null, score: 0 }),
    ];
    assignments = [
      { ip: "172.31.250.130", path: "direct" },
      { ip: "172.31.250.131", path: "direct" },
    ];
    peerStats = [peers("172.31.250.130", 5, null, null), peers("172.31.250.131", 12, 4, 1)];
    const changed = await scrape();
    expect(changed).toMatchObject({
      aceswarm_paths: 2,
      'aceswarm_path_up{path="direct"}': 1,
      'aceswarm_path_up{path="wg:vpn"}': 0,
      'aceswarm_path_score{path="wg:vpn"}': 0,
      'aceswarm_path_engines{path="direct"}': 2,
      'aceswarm_path_engines{path="wg:vpn"}': 0,
      'aceswarm_engine_peers{engine_ip="172.31.250.130",kind="connected"}': 5,
      'aceswarm_engine_peers{engine_ip="172.31.250.131",kind="connected"}': 12,
      'aceswarm_engine_peers{engine_ip="172.31.250.131",kind="active"}': 4,
      'aceswarm_engine_peers{engine_ip="172.31.250.131",kind="uploading"}': 1,
    });
    // Values the path no longer has are not left over from before.
    expect(changed).not.toHaveProperty('aceswarm_path_rtt_seconds{path="wg:vpn"}');
    expect(changed).not.toHaveProperty('aceswarm_path_loss_ratio{path="wg:vpn"}');
    expect(changed).not.toHaveProperty('aceswarm_path_handshake_age_seconds{path="wg:vpn"}');
    expect(changed).not.toHaveProperty('aceswarm_engine_peers{engine_ip="172.31.250.130",kind="active"}');
    expect(changed).not.toHaveProperty('aceswarm_engine_peers{engine_ip="172.31.250.130",kind="uploading"}');

    // The tunnel and the first engine go away.
    paths = [path("direct")];
    assignments = [{ ip: "172.31.250.131", path: "direct" }];
    peerStats = [peers("172.31.250.131", 12, 4, 1)];
    const gone = await scrape();
    expect(gone).toMatchObject({ aceswarm_paths: 1, 'aceswarm_path_engines{path="direct"}': 1 });
    expect(
      Object.keys(gone).filter((series) => series.includes("wg:vpn") || series.includes("172.31.250.130")),
    ).toEqual([]);
  });

  test("shows the policy that is in force at the one scrape", async () => {
    expect(await scrape()).toMatchObject({ aceswarm_gateway_wireguard_only: 0 });
    wireguardOnly = true;
    expect(await scrape()).toMatchObject({ aceswarm_gateway_wireguard_only: 1 });
  });
});
