import type {
  PathAssignment,
  PathStatus,
  PeerStats,
  PipelineRequest,
  PipelineStatus,
  StandbyReaderStatus,
} from "@aceswarm/shared/api-types";
import { HttpError, requestJson, requestOk } from "@aceswarm/shared/http";

/** Client for the transcoder service, which runs one ffmpeg pipeline per stream. */
export class TranscoderClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Starts (or replaces) the pipeline of a stream. With `handover`, the current output keeps
   * playing until the new source produces video, which avoids a visible gap on path switches.
   */
  async start(id: string, request: PipelineRequest, handover = false): Promise<PipelineStatus> {
    return requestJson<PipelineStatus>(
      `${this.baseUrl}/pipelines/${encodeURIComponent(id)}?handover=${String(handover)}`,
      { method: "PUT", body: request },
    );
  }

  async status(id: string): Promise<PipelineStatus | undefined> {
    try {
      return await requestJson<PipelineStatus>(`${this.baseUrl}/pipelines/${encodeURIComponent(id)}`, {
        timeoutMs: 3000,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async stop(id: string): Promise<void> {
    await requestOk(`${this.baseUrl}/pipelines/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * Has the transcoder read exactly these standby sources of the stream, which keeps them pulling
   * the stream (see `StreamStandbys`). Returns their status, or undefined while the stream has no
   * pipeline.
   */
  async setStandbys(id: string, sources: string[]): Promise<StandbyReaderStatus[] | undefined> {
    try {
      return await requestJson<StandbyReaderStatus[]>(`${this.baseUrl}/standbys/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: { sources },
        timeoutMs: 3000,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async list(): Promise<PipelineStatus[]> {
    return requestJson<PipelineStatus[]>(`${this.baseUrl}/pipelines`, { timeoutMs: 3000 });
  }
}

/** Client for the network gateway, which owns the WireGuard tunnels and per-engine routing. */
export class NetgwClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async paths(): Promise<PathStatus[]> {
    return requestJson<PathStatus[]>(`${this.baseUrl}/paths`, { timeoutMs: 3000 });
  }

  async assign(assignment: PathAssignment): Promise<void> {
    await requestOk(`${this.baseUrl}/assignments/${encodeURIComponent(assignment.ip)}`, {
      method: "PUT",
      body: { path: assignment.path },
    });
  }

  /** Sends the complete list of engine paths; returns the ones the gateway refused. */
  async sync(assignments: PathAssignment[]): Promise<(PathAssignment & { error: string })[]> {
    const result = await requestJson<{ rejected: (PathAssignment & { error: string })[] }>(
      `${this.baseUrl}/assignments`,
      { method: "PUT", body: { assignments }, timeoutMs: 10_000 },
    );
    return result.rejected;
  }

  async unassign(ip: string): Promise<void> {
    await requestOk(`${this.baseUrl}/assignments/${encodeURIComponent(ip)}`, { method: "DELETE" });
  }

  async peers(ip: string): Promise<PeerStats> {
    return requestJson<PeerStats>(`${this.baseUrl}/peers/${encodeURIComponent(ip)}`, { timeoutMs: 3000 });
  }

  async reload(): Promise<void> {
    await requestOk(`${this.baseUrl}/reload`, { method: "POST", timeoutMs: 30_000 });
  }
}
