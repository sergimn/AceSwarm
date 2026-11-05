import { envBool, envInt, envList, parseEnv } from "@aceswarm/shared/env";
import { z } from "zod";

const cidrList = z.array(z.cidrv4());

const schema = z.object({
  PORT: envInt(8082),
  /** Directory with the WireGuard profiles (shared read-only with the controller). */
  WIREGUARD_DIR: z.string().default("/config/wireguard"),
  RUNTIME_DIR: z.string().default("/run/aceswarm"),
  /** Subnet of the engines network; the interface holding an address in it faces the engines. */
  ENGINE_SUBNET: z.cidrv4().default("172.31.250.0/24"),
  PROBE_TARGETS: envList(["1.1.1.1", "9.9.9.9"]),
  PROBE_INTERVAL_SECONDS: envInt(15),
  /** A tunnel without a handshake for this long is considered down. */
  HANDSHAKE_MAX_AGE_SECONDS: envInt(180),
  PEERS_INTERVAL_SECONDS: envInt(5),
  GEOIP_DB: z.string().default("/var/lib/aceswarm/geoip/dbip-country-lite.mmdb"),
  /** Monthly DB-IP Lite country database (CC BY 4.0), downloaded when missing or outdated. */
  GEOIP_URL_TEMPLATE: z.string().default("https://download.db-ip.com/free/dbip-country-lite-{YYYY}-{MM}.mmdb.gz"),
  GEOIP_DOWNLOAD: envBool(true),
  /** Fixed countries for some addresses, as `ip=CC` items (for tests and private peers). */
  GEOIP_STATIC: envList([]),
  /** Remote ports that are services rather than peers (DNS, HTTP, HTTPS). */
  IGNORED_PEER_PORTS: envList(["53", "80", "443"]),
  /** Use wireguard-go when the kernel has no WireGuard module (needs /dev/net/tun). */
  WIREGUARD_USERSPACE_FALLBACK: envBool(true),
  /**
   * Private networks engines may reach anyway, as CIDRs (for example LAN peers). Everything else
   * private, link-local or local is dropped, including the host's published ports.
   */
  ENGINE_ALLOWED_PRIVATE: envList([]).pipe(cidrList),
  /** iptables flavour; use `iptables-legacy` on hosts whose kernel lacks nf_tables. */
  IPTABLES: z.enum(["iptables", "iptables-nft", "iptables-legacy"]).default("iptables"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseEnv(schema, env);
}
