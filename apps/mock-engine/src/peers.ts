import { createSocket, type Socket } from "node:dgram";
import type { Logger } from "@aceswarm/shared/logger";

const PING = Buffer.from("aceswarm-mock-ping");
const REPLY_WINDOW_MS = 5000;

export interface PeerAddress {
  host: string;
  port: number;
}

export function parsePeer(value: string): PeerAddress | undefined {
  const match = /^([\w.-]+):(\d{1,5})$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  const port = Number.parseInt(match[2], 10);
  return port > 0 && port < 65_536 ? { host: match[1], port } : undefined;
}

/**
 * Pings mock peers over UDP once a second. The traffic goes through the engine's network path,
 * so the gateway sees real flows (and counts the peers), and a broken path means no replies.
 */
export class PeerPinger {
  private readonly peers: PeerAddress[];
  private readonly vpnPeers: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly lastReply = new Map<string, number>();
  private socket: Socket | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(peers: PeerAddress[], vpnPeers: PeerAddress[] = [], now: () => number = Date.now) {
    this.peers = [...peers, ...vpnPeers];
    this.vpnPeers = new Set(vpnPeers.map((peer) => `${peer.host}:${String(peer.port)}`));
    this.now = now;
  }

  get configured(): boolean {
    return this.peers.length > 0;
  }

  start(): void {
    if (!this.configured || this.socket !== undefined) {
      return;
    }
    const socket = createSocket("udp4");
    socket.on("message", (_message, remote) => {
      this.recordReply(`${remote.address}:${String(remote.port)}`);
    });
    socket.on("error", () => {
      // Unreachable peers are expected when the network path is down.
    });
    this.socket = socket;
    const ping = (): void => {
      for (const peer of this.peers) {
        socket.send(PING, peer.port, peer.host, () => {
          // Send errors (for example no route) just mean no reply.
        });
      }
    };
    ping();
    this.timer = setInterval(ping, 1000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.socket?.close();
    this.socket = undefined;
  }

  recordReply(key: string): void {
    this.lastReply.set(key, this.now());
  }

  /** Peers that answered within the last few seconds. */
  reachable(): number {
    return this.answering().length;
  }

  /** VPN-only peers that answered within the last few seconds. */
  vpnReachable(): number {
    return this.answering().filter((key) => this.vpnPeers.has(key)).length;
  }

  private answering(): string[] {
    const cutoff = this.now() - REPLY_WINDOW_MS;
    return this.lastReply
      .entries()
      .filter(([, at]) => at >= cutoff)
      .map(([key]) => key)
      .toArray();
  }
}

/** The `peer` side: answers every ping with a payload so the gateway sees data flowing in. */
export function startPeerEcho(port: number, replyBytes: number, logger: Logger): Socket {
  const socket = createSocket("udp4");
  const payload = Buffer.alloc(replyBytes, 0x47);
  socket.on("message", (_message, remote) => {
    socket.send(payload, remote.port, remote.address);
  });
  socket.on("error", (error) => {
    logger.error({ err: error }, "peer socket error");
  });
  socket.bind(port, () => {
    logger.info({ port }, "mock peer listening");
  });
  return socket;
}
