/**
 * A minimal BitTorrent HTTP tracker for the multi-machine E2E tests. The Acestream broadcast
 * source's built-in tracker refuses announces ("Requested download is not authorized for use with
 * this tracker"), so the source announces to this one instead and players find it here.
 *
 *   node e2e/multi/tracker.ts --port 7700 [--host 0.0.0.0]
 *
 * It keeps the peers of every info hash in memory and answers with compact peer lists. A peer's
 * address is the connection's source address, which on the mesh is the runner's mesh address.
 * `GET /stats` lists every address that announced, so the tests can tell which runner an engine's
 * traffic came out of (the AceSwarm runner itself, or the WireGuard server's runner).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";

const PEER_TTL_MS = 120_000;
const ANNOUNCE_INTERVAL_SECONDS = 15;

type Bencodable = number | string | Buffer | Bencodable[] | { [key: string]: Bencodable };

export function bencode(value: Bencodable): Buffer {
  if (typeof value === "number") {
    return Buffer.from(`i${String(Math.trunc(value))}e`);
  }
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([Buffer.from(`${String(bytes.length)}:`), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from("l"), ...value.map((item) => bencode(item)), Buffer.from("e")]);
  }
  // Bencoded dictionaries need their keys in raw byte order.
  const keys = Object.keys(value).toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat([
    Buffer.from("d"),
    ...keys.flatMap((key) => [bencode(key), bencode(value[key] ?? "")]),
    Buffer.from("e"),
  ]);
}

/** Decodes a query string value byte by byte: info_hash and peer_id are raw bytes, not UTF-8. */
export function percentDecodeBytes(value: string): Buffer {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "%" && index + 2 < value.length) {
      const byte = Number.parseInt(value.slice(index + 1, index + 3), 16);
      if (!Number.isNaN(byte)) {
        bytes.push(byte);
        index += 2;
        continue;
      }
    }
    bytes.push(char === "+" ? 0x20 : (char?.codePointAt(0) ?? 0) & 0xff);
  }
  return Buffer.from(bytes);
}

export interface Announce {
  infoHash: string;
  port: number;
  event: string | undefined;
  compact: boolean;
}

export function parseAnnounce(rawQuery: string): Announce | undefined {
  const fields = new Map<string, string>();
  for (const pair of rawQuery.split("&")) {
    const [key = "", value = ""] = pair.split("=", 2);
    fields.set(key, value);
  }
  const infoHash = percentDecodeBytes(fields.get("info_hash") ?? "");
  const port = Number.parseInt(fields.get("port") ?? "", 10);
  if (infoHash.length !== 20 || !(port > 0 && port < 65_536)) {
    return undefined;
  }
  return {
    infoHash: infoHash.toString("hex"),
    port,
    event: fields.get("event"),
    compact: fields.get("compact") !== "0",
  };
}

interface Peer {
  ip: string;
  port: number;
  seen: number;
}

export interface PeerHistory {
  ip: string;
  port: number;
  firstSeen: string;
  lastSeen: string;
}

export class Swarm {
  private readonly torrents = new Map<string, Map<string, Peer>>();
  private readonly history = new Map<string, Map<string, PeerHistory>>();

  /** Records the announce and returns the other live peers of the same info hash. */
  announce(announce: Announce, ip: string, now: number = Date.now()): Peer[] {
    const peers = this.torrents.get(announce.infoHash) ?? new Map<string, Peer>();
    this.torrents.set(announce.infoHash, peers);
    const key = `${ip}:${String(announce.port)}`;
    this.remember(announce.infoHash, key, ip, announce.port, now);
    if (announce.event === "stopped") {
      peers.delete(key);
    } else {
      peers.set(key, { ip, port: announce.port, seen: now });
    }
    for (const [peerKey, peer] of peers) {
      if (now - peer.seen > PEER_TTL_MS) {
        peers.delete(peerKey);
      }
    }
    return peers
      .entries()
      .filter(([peerKey]) => peerKey !== key)
      .map(([, peer]) => peer)
      .toArray();
  }

  /** Every address that ever announced, per info hash. */
  stats(): Record<string, PeerHistory[]> {
    return Object.fromEntries(this.history.entries().map(([infoHash, peers]) => [infoHash, peers.values().toArray()]));
  }

  private remember(infoHash: string, key: string, ip: string, port: number, now: number): void {
    const peers = this.history.get(infoHash) ?? new Map<string, PeerHistory>();
    this.history.set(infoHash, peers);
    const at = new Date(now).toISOString();
    peers.set(key, { ip, port, firstSeen: peers.get(key)?.firstSeen ?? at, lastSeen: at });
  }
}

export function compactPeers(peers: Peer[]): Buffer {
  return Buffer.concat(
    peers
      .filter((peer) => /^\d+\.\d+\.\d+\.\d+$/.test(peer.ip))
      .map((peer) => {
        const entry = Buffer.alloc(6);
        for (const [index, part] of peer.ip.split(".").entries()) {
          entry[index] = Number.parseInt(part, 10);
        }
        entry.writeUInt16BE(peer.port, 4);
        return entry;
      }),
  );
}

function handle(swarm: Swarm, request: IncomingMessage, response: ServerResponse): void {
  const [path = "", query = ""] = (request.url ?? "").split("?", 2);
  if (path === "/stats") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(swarm.stats()));
    return;
  }
  const announce = path === "/announce" ? parseAnnounce(query) : undefined;
  const reply = (body: Bencodable): void => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(bencode(body));
  };
  if (announce === undefined) {
    reply({ "failure reason": "bad announce" });
    return;
  }
  const ip = (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const peers = swarm.announce(announce, ip);
  process.stdout.write(
    `${new Date().toISOString()} ${announce.infoHash} ${ip}:${String(announce.port)} ${announce.event ?? "-"} -> ${String(peers.length)} peers\n`,
  );
  reply({
    interval: ANNOUNCE_INTERVAL_SECONDS,
    "min interval": 5,
    peers: announce.compact ? compactPeers(peers) : peers.map((peer) => ({ ip: peer.ip, port: peer.port })),
  });
}

function main(): void {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "7700" }, host: { type: "string", default: "0.0.0.0" } },
  });
  const swarm = new Swarm();
  const server = createServer((request, response) => {
    handle(swarm, request, response);
  });
  server.listen(Number.parseInt(values.port, 10), values.host, () => {
    process.stdout.write(`tracker listening on ${values.host}:${values.port}\n`);
  });
  const stop = (): void => {
    server.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.main) {
  main();
}
