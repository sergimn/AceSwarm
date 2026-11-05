import { execFileSync } from "node:child_process";
import { expect, type APIRequestContext } from "@playwright/test";

/**
 * The other runners, as this runner reaches them through the mesh (e2e/mesh.sh). Each one
 * shares files on port 18999; the broadcast runner also runs the tracker on port 7700.
 */
export const MESH = {
  self: process.env["MESH_SELF_IP"] ?? "192.0.2.3",
  wg: process.env["MESH_WG_IP"] ?? "192.0.2.1",
  source: process.env["MESH_SOURCE_IP"] ?? "192.0.2.2",
};

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)}`);
  }
  return await response.text();
}

/** The client profile the WireGuard server on the other runner generated for this run. */
export async function remoteWireguardProfile(): Promise<string> {
  return await fetchText(`http://${MESH.wg}:18999/client.conf`);
}

export interface Broadcast {
  /** The source's name on the broadcast runner (bc1, bc2, ...). */
  name: string;
  infohash: string;
  /** What acestream:// links carry. Players resolve it through Acestream's lookup service. */
  contentId: string;
}

/** The dummy broadcasts on the broadcast runner (e2e/broadcast.sh), at least `count` of them. */
export async function broadcasts(count: number): Promise<Broadcast[]> {
  const list = JSON.parse(await fetchText(`http://${MESH.source}:18999/broadcasts.json`)) as Broadcast[];
  expect(list.length).toBeGreaterThanOrEqual(count);
  for (const broadcast of list) {
    expect(broadcast.infohash).toMatch(/^[0-9a-f]{40}$/);
    expect(broadcast.contentId).toMatch(/^[0-9a-f]{40}$/);
  }
  return list;
}

export interface Announce {
  ip: string;
  port: number;
  firstSeen: string;
  lastSeen: string;
}

/** Every address that announced the infohash to the broadcast runner's tracker. */
export async function announces(infohash: string): Promise<Announce[]> {
  const stats = JSON.parse(await fetchText(`http://${MESH.source}:7700/stats`)) as Record<string, Announce[]>;
  return stats[infohash] ?? [];
}

/**
 * The tracker's time of the latest announce from an address, or "" if it never announced. Tests
 * compare two of these instead of using this runner's clock, which may differ from the tracker's.
 */
export async function lastAnnounce(infohash: string, ip: string): Promise<string> {
  const times = (await announces(infohash)).filter((announce) => announce.ip === ip).map(({ lastSeen }) => lastSeen);
  // ISO 8601 times in UTC sort as strings.
  return times.toSorted((a, b) => a.localeCompare(b, "en")).at(-1) ?? "";
}

/** Adds or removes a DROP rule for traffic this runner's containers forward (DOCKER-USER). */
function setForwardDrop(match: string[], drop: boolean): void {
  const rule = ["DOCKER-USER", ...match, "-m", "comment", "--comment", "aceswarm-e2e", "-j", "DROP"];
  const present = (): boolean => {
    try {
      execFileSync("sudo", ["iptables", "-C", ...rule], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (drop && !present()) {
    execFileSync("sudo", ["iptables", "-I", ...rule]);
  }
  while (!drop && present()) {
    execFileSync("sudo", ["iptables", "-D", ...rule]);
  }
}

/**
 * Drops traffic from this runner's containers to the broadcast runner, like an ISP blocking the
 * swarm. It only affects forwarded traffic, so the gateway's direct path loses the broadcasts
 * while WireGuard (to the other runner) and the tests' own requests still work. The direct path
 * still answers the gateway's pings, which go to the WireGuard server's runner.
 */
export function setDirectPathBlocked(blocked: boolean): void {
  setForwardDrop(["-d", `${MESH.source}/32`], blocked);
}

/**
 * Drops the gateway's WireGuard packets to the WireGuard server, like a VPN provider that went
 * away: the tunnel stops working and its path goes down. The direct path keeps working.
 */
export function setVpnServerUnreachable(unreachable: boolean): void {
  setForwardDrop(["-d", `${MESH.wg}/32`, "-p", "udp", "--dport", "51820"], unreachable);
}

/** Fetches the stream's full-quality HLS playlist and its newest segment. */
export async function newestSegment(request: APIRequestContext, playlistUrl: string): Promise<Buffer> {
  const playlist = await (await request.get(playlistUrl)).text();
  const segments = playlist.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
  const newest = segments.at(-1);
  expect(newest, playlist).toBeDefined();
  const response = await request.get(new URL(newest!, new URL(playlistUrl, "http://host")).pathname);
  expect(response.ok()).toBe(true);
  return await response.body();
}
