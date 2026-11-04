import { describeError, HttpError } from "@aceswarm/shared/http";

/** Subset of `GET /containers/json` items that the controller uses. */
export interface ContainerSummary {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
}

/** Subset of `GET /containers/{id}/json`. */
export interface ContainerDetails {
  Id: string;
  Name: string;
  State: { Running: boolean; Status: string; ExitCode: number; StartedAt: string };
  Config: { Labels: Record<string, string> };
  NetworkSettings: { Networks: Record<string, { IPAddress: string } | undefined> };
}

export interface ContainerSpec {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: Record<string, unknown>;
  NetworkingConfig?: Record<string, unknown>;
}

/**
 * Minimal Docker Engine API client. It talks to a docker-socket-proxy over TCP, which only allows
 * the container, image and network endpoints the controller needs.
 */
export class DockerClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async ping(): Promise<boolean> {
    try {
      await this.call("GET", "/_ping", undefined, [200]);
      return true;
    } catch {
      return false;
    }
  }

  async listContainers(labels: Record<string, string>): Promise<ContainerSummary[]> {
    const filters = JSON.stringify({
      label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
    });
    const response = await this.call(
      "GET",
      `/containers/json?all=1&filters=${encodeURIComponent(filters)}`,
      undefined,
      [200],
    );
    return (await response.json()) as ContainerSummary[];
  }

  async inspectContainer(id: string): Promise<ContainerDetails | undefined> {
    const response = await this.call("GET", `/containers/${encodeURIComponent(id)}/json`, undefined, [200, 404]);
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    return (await response.json()) as ContainerDetails;
  }

  async createContainer(name: string, spec: ContainerSpec): Promise<string> {
    const response = await this.call("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec, [201]);
    const body = (await response.json()) as { Id: string };
    return body.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.drain(this.call("POST", `/containers/${encodeURIComponent(id)}/start`, undefined, [204, 304]));
  }

  async restartContainer(id: string, timeoutSeconds = 10): Promise<void> {
    await this.drain(
      this.call("POST", `/containers/${encodeURIComponent(id)}/restart?t=${String(timeoutSeconds)}`, undefined, [204]),
    );
  }

  async removeContainer(id: string): Promise<void> {
    await this.drain(this.call("DELETE", `/containers/${encodeURIComponent(id)}?force=1&v=1`, undefined, [204, 404]));
  }

  async imageExists(reference: string): Promise<boolean> {
    const response = await this.call("GET", `/images/${encodeURIComponent(reference)}/json`, undefined, [200, 404]);
    await response.body?.cancel();
    return response.status === 200;
  }

  /** Pulls an image and waits until the pull stream ends. */
  async pullImage(reference: string): Promise<void> {
    const response = await this.call(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(reference)}`,
      undefined,
      [200],
      600_000,
    );
    const text = await response.text();
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const event = JSON.parse(line) as { error?: string };
      if (event.error !== undefined) {
        throw new HttpError(`pull of ${reference} failed: ${event.error}`, this.baseUrl);
      }
    }
  }

  private async drain(response: Promise<Response>): Promise<void> {
    const resolved = await response;
    await resolved.body?.cancel();
  }

  private async call(
    method: string,
    path: string,
    body: unknown,
    expected: number[],
    timeoutMs = 60_000,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new HttpError(`docker ${method} ${path} failed: ${describeError(error)}`, url, undefined, {
        cause: error,
      });
    }
    if (!expected.includes(response.status)) {
      const text = await response.text();
      throw new HttpError(
        `docker ${method} ${path} returned ${String(response.status)}: ${text.slice(0, 300)}`,
        url,
        response.status,
      );
    }
    return response;
  }
}
