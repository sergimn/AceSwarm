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

/** How long a source that the browser gave up on is left alone before a new one replaces it. */
export const RECONNECT_DELAY_MS = 3000;
/**
 * A connection that delivers nothing for this long is replaced, although it never reported an
 * error: the controller sends a snapshot every 2 seconds, and one that dropped silently (a lost
 * Wi-Fi) can look open for minutes.
 */
export const SILENT_RECONNECT_MS = 10_000;
const WATCHDOG_MS = 2000;

/**
 * Receives a snapshot every couple of seconds over Server-Sent Events. The browser reconnects by
 * itself after a dropped connection, but not after an HTTP error answer (a reverse proxy's 502
 * while the controller restarts): the source is then closed for good. So a closed source, and a
 * silent one, are replaced with a new one.
 */
export function subscribeSnapshots(
  onSnapshot: (snapshot: Snapshot) => void,
  onStatus: (status: ConnectionStatus) => void,
): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heardAt = performance.now();
  let stopped = false;

  const connect = (): void => {
    heardAt = performance.now();
    const current = new EventSource("/api/events");
    source = current;
    current.addEventListener("open", () => {
      heardAt = performance.now();
      onStatus("live");
    });
    current.addEventListener("error", () => {
      onStatus("reconnecting");
      if (current.readyState === EventSource.CLOSED && retry === undefined && !stopped) {
        retry = setTimeout(() => {
          retry = undefined;
          if (!stopped) {
            connect();
          }
        }, RECONNECT_DELAY_MS);
      }
    });
    current.addEventListener("snapshot", (event) => {
      heardAt = performance.now();
      onSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
    });
  };

  onStatus("connecting");
  connect();
  const watchdog = setInterval(() => {
    if (retry !== undefined || performance.now() - heardAt <= SILENT_RECONNECT_MS) {
      return;
    }
    source?.close();
    onStatus("reconnecting");
    connect();
  }, WATCHDOG_MS);
  return () => {
    stopped = true;
    clearTimeout(retry);
    retry = undefined;
    clearInterval(watchdog);
    source?.close();
  };
}
