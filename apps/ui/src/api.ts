import type { NetworkPolicy, Settings, Snapshot, StreamView, WireguardProfileView } from "@aceswarm/shared/api-types";

export class ApiError extends Error {
  readonly status: number;
  readonly details: string[];

  constructor(message: string, status: number, details: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

interface ErrorBody {
  error?: string;
  details?: string[];
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.headers = { accept: "application/json", "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as ErrorBody;
    throw new ApiError(
      error.error ?? `Request failed (${String(response.status)})`,
      response.status,
      error.details ?? [],
    );
  }
  return response;
}

async function json(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await send(method, path, body);
  return response.json();
}

export const api = {
  snapshot: async (): Promise<Snapshot> => (await json("GET", "/api/snapshot")) as Snapshot,
  addStream: async (aceId: string, name: string): Promise<StreamView> =>
    (await json("POST", "/api/streams", name.length > 0 ? { aceId, name } : { aceId })) as StreamView,
  updateStream: async (id: string, patch: { name?: string; enabled?: boolean }): Promise<StreamView> =>
    (await json("PATCH", `/api/streams/${encodeURIComponent(id)}`, patch)) as StreamView,
  removeStream: async (id: string): Promise<void> => {
    await send("DELETE", `/api/streams/${encodeURIComponent(id)}`);
  },
  restartStream: async (id: string): Promise<void> => {
    await send("POST", `/api/streams/${encodeURIComponent(id)}/restart`);
  },
  profiles: async (): Promise<WireguardProfileView[]> =>
    (await json("GET", "/api/wireguard")) as WireguardProfileView[],
  saveProfile: async (name: string, config: string): Promise<WireguardProfileView> =>
    (await json("POST", "/api/wireguard", { name, config })) as WireguardProfileView,
  removeProfile: async (name: string): Promise<void> => {
    await send("DELETE", `/api/wireguard/${encodeURIComponent(name)}`);
  },
  setNetworkPolicy: async (policy: NetworkPolicy): Promise<NetworkPolicy> =>
    (await json("PATCH", "/api/network", policy)) as NetworkPolicy,
  updateSettings: async (settings: Partial<Settings>): Promise<Settings> =>
    (await json("PATCH", "/api/settings", settings)) as Settings,
  reportViewer: async (viewer: string, stream: string | null): Promise<void> => {
    await send("POST", `/api/viewers/${encodeURIComponent(viewer)}`, { stream });
  },
  /** Like `reportViewer`, for a page that is going away: the request outlives it. */
  leaveViewer: (viewer: string): void => {
    void fetch(`/api/viewers/${encodeURIComponent(viewer)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stream: null }),
      keepalive: true,
    }).catch(() => undefined);
  },
};

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

/** Receives a snapshot every couple of seconds over Server-Sent Events (the browser reconnects). */
export function subscribeSnapshots(
  onSnapshot: (snapshot: Snapshot) => void,
  onStatus: (status: ConnectionStatus) => void,
): () => void {
  onStatus("connecting");
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    onStatus("live");
  });
  source.addEventListener("error", () => {
    onStatus("reconnecting");
  });
  source.addEventListener("snapshot", (event) => {
    onSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
  });
  return () => {
    source.close();
  };
}
