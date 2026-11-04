import { envInt, envList, parseEnv } from "@aceswarm/shared/env";
import { z } from "zod";

const schema = z.object({
  /** `engine` serves the Acestream API; `peer` answers the engine's UDP pings like a remote peer. */
  MOCK_MODE: z.enum(["engine", "peer"]).default("engine"),
  PORT: envInt(6878),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  MOCK_VIDEO_SIZE: z
    .string()
    .regex(/^\d{2,4}x\d{2,4}$/)
    .default("960x540"),
  MOCK_FPS: envInt(25),
  /** How long loading content takes before a session starts. */
  MOCK_LOAD_DELAY_MS: envInt(1500),
  /** Streams whose ID starts with `0bad` stop delivering data after this long. */
  MOCK_STALL_AFTER_SECONDS: envInt(15),
  /** UDP peers (`host:port`) the engine pings through its network path. */
  MOCK_PEERS: envList([]),
  /** Peers only reachable through a VPN; streams whose ID starts with `beef` need one of them. */
  MOCK_VPN_PEERS: envList([]),
  /** UDP port the `peer` mode listens on. */
  MOCK_PEER_PORT: envInt(8621),
  MOCK_PEER_REPLY_BYTES: envInt(1200),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return parseEnv(schema, env);
}
