/**
 * Minimal STUN client (RFC 5389 Binding requests) for the end-to-end test workflow.
 *
 * GitHub-hosted runners sit behind a NAT that keeps the same public port for one local port
 * whatever the destination (endpoint-independent mapping), so the address STUN reports for a local
 * UDP port is also the address other runners can reach that port on once it has sent to them.
 *
 *   node e2e/stun.ts --port 51000 [--server host:port]... [--out file] [--keepalive seconds]
 *
 * Prints {"ip","port","mappings":[...],"endpointIndependent"} and writes it to --out. With
 * --keepalive it keeps refreshing the mapping from the same port until it gets SIGTERM, so the NAT
 * does not forget it before WireGuard takes the port over.
 */
import { randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const MAGIC_COOKIE = 0x21_12_a4_42;
const BINDING_REQUEST = 0x00_01;
const BINDING_SUCCESS = 0x01_01;
const ATTR_MAPPED_ADDRESS = 0x00_01;
const ATTR_XOR_MAPPED_ADDRESS = 0x00_20;
const DEFAULT_SERVERS = ["stun.l.google.com:19302", "stun.cloudflare.com:3478"];

interface Mapping {
  server: string;
  ip: string;
  port: number;
}

/** Decodes the mapped address of a Binding success response, or undefined if it is not one. */
export function parseBindingResponse(message: Buffer, transactionId: Buffer): { ip: string; port: number } | undefined {
  if (
    message.length < 20 ||
    message.readUInt16BE(0) !== BINDING_SUCCESS ||
    message.readUInt32BE(4) !== MAGIC_COOKIE ||
    !message.subarray(8, 20).equals(transactionId)
  ) {
    return undefined;
  }
  let fallback: { ip: string; port: number } | undefined;
  let offset = 20;
  const end = Math.min(message.length, 20 + message.readUInt16BE(2));
  while (offset + 4 <= end) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const value = message.subarray(offset + 4, offset + 4 + length);
    // Only IPv4 (family 0x01): the runners have no IPv6.
    if (value.length >= 8 && value[1] === 0x01) {
      const port = value.readUInt16BE(2);
      const address = value.readUInt32BE(4);
      if (type === ATTR_XOR_MAPPED_ADDRESS) {
        return { ip: ipv4((address ^ MAGIC_COOKIE) >>> 0), port: port ^ (MAGIC_COOKIE >>> 16) };
      }
      if (type === ATTR_MAPPED_ADDRESS) {
        fallback = { ip: ipv4(address), port };
      }
    }
    offset += 4 + Math.ceil(length / 4) * 4;
  }
  return fallback;
}

function ipv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

function bindingRequest(transactionId: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_REQUEST, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return header;
}

/** Sends one Binding request and waits briefly for its answer. */
function ask(socket: Socket, server: string): Promise<Mapping | undefined> {
  const [host = server, portText = "3478"] = server.split(":", 2);
  const transactionId = randomBytes(12);
  return new Promise((resolve) => {
    const finish = (result: Mapping | undefined): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(undefined);
    }, 1500);
    const onMessage = (message: Buffer): void => {
      const mapped = parseBindingResponse(message, transactionId);
      if (mapped === undefined) {
        return;
      }
      finish({ server, ...mapped });
    };
    socket.on("message", onMessage);
    socket.send(bindingRequest(transactionId), Number.parseInt(portText, 10), host, (error) => {
      if (error === null) {
        return;
      }
      finish(undefined);
    });
  });
}

/** Asks one server for this socket's public address, retrying a few times (UDP may drop). */
async function query(socket: Socket, server: string, attempts: number): Promise<Mapping | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await ask(socket, server);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "51000" },
      server: { type: "string", multiple: true },
      out: { type: "string" },
      keepalive: { type: "string" },
    },
  });
  const servers = values.server ?? DEFAULT_SERVERS;
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(Number.parseInt(values.port, 10), () => {
      resolve();
    });
  });

  const mappings: Mapping[] = [];
  for (const server of servers) {
    const mapping = await query(socket, server, 4);
    if (mapping !== undefined) {
      mappings.push(mapping);
    }
  }
  const [first] = mappings;
  if (first === undefined) {
    process.stderr.write(`no STUN server answered (${servers.join(", ")})\n`);
    process.exit(1);
  }
  const result = {
    localPort: Number.parseInt(values.port, 10),
    ip: first.ip,
    port: first.port,
    mappings,
    endpointIndependent: mappings.every((mapping) => mapping.ip === first.ip && mapping.port === first.port),
  };
  const json = JSON.stringify(result);
  process.stdout.write(`${json}\n`);
  if (values.out !== undefined) {
    writeFileSync(values.out, `${json}\n`);
  }

  if (values.keepalive === undefined) {
    socket.close();
    return;
  }
  const intervalMs = Number.parseInt(values.keepalive, 10) * 1000;
  const timer = setInterval(() => {
    void query(socket, first.server, 1);
  }, intervalMs);
  const stop = (): void => {
    clearInterval(timer);
    socket.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.main) {
  await main();
}
