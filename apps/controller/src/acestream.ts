import { getstreamParameter, type AceIdKind } from "@aceswarm/shared/ace-id";
import { requestJson } from "@aceswarm/shared/http";

/** Error reported by the engine itself (for example "failed to load content"). */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export interface EngineSession {
  playbackUrl: string;
  statUrl: string;
  commandUrl: string;
}

/** What an engine's stat answer says about a session. A figure the engine left out is `null`, not 0. */
export interface EngineStats {
  status: string;
  peers: number | null;
  speedDown: number | null;
  speedUp: number | null;
  downloaded: number | null;
  uploaded: number | null;
}

interface Envelope<T> {
  response: T | null;
  error: string | null;
}

interface RawSession {
  playback_url: string;
  stat_url: string;
  command_url: string;
}

interface RawStats {
  status?: string;
  peers?: number;
  speed_down?: number;
  speed_up?: number;
  downloaded?: number;
  uploaded?: number;
}

function unwrap<T>(envelope: Envelope<T>, what: string): T {
  if (envelope.error !== null || envelope.response === null) {
    throw new EngineError(`${what}: ${envelope.error ?? "empty response"}`);
  }
  return envelope.response;
}

/**
 * Client for the Acestream engine HTTP API (see docs.acestream.net/developers). Each stream uses
 * its own engine, so the controller is the only client and reads each stream exactly once.
 */
export class AcestreamClient {
  async version(baseUrl: string): Promise<string> {
    const body = await requestJson<{ result?: { version?: string } | null; error?: string | null }>(
      `${baseUrl}/webui/api/service?method=get_version&format=json`,
      { timeoutMs: 3000 },
    );
    const version = body.result?.version;
    if (version === undefined) {
      throw new EngineError(`version check failed: ${body.error ?? "no version in response"}`);
    }
    return version;
  }

  /** Starts a playback session. Loading content can take a while, hence the long timeout. */
  async startSession(baseUrl: string, aceId: string, kind: AceIdKind, playerId: string): Promise<EngineSession> {
    const query = new URLSearchParams({ [getstreamParameter(kind)]: aceId, format: "json", pid: playerId });
    const body = await requestJson<Envelope<RawSession>>(`${baseUrl}/ace/getstream?${query.toString()}`, {
      timeoutMs: 90_000,
    });
    const session = unwrap(body, "start session");
    return {
      playbackUrl: session.playback_url,
      statUrl: session.stat_url,
      commandUrl: session.command_url,
    };
  }

  async stats(statUrl: string): Promise<EngineStats> {
    const body = await requestJson<Envelope<RawStats>>(statUrl, { timeoutMs: 5000 });
    const stats = unwrap(body, "stats");
    return {
      status: stats.status ?? "unknown",
      peers: stats.peers ?? null,
      speedDown: stats.speed_down ?? null,
      speedUp: stats.speed_up ?? null,
      downloaded: stats.downloaded ?? null,
      uploaded: stats.uploaded ?? null,
    };
  }

  async stopSession(commandUrl: string): Promise<void> {
    const separator = commandUrl.includes("?") ? "&" : "?";
    await requestJson<Envelope<string>>(`${commandUrl}${separator}method=stop`, { timeoutMs: 5000 });
  }
}
