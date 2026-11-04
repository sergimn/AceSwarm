/** Error raised when an HTTP call returns a non-2xx status or cannot be completed. */
export class HttpError extends Error {
  readonly status: number | undefined;
  readonly url: string;

  constructor(message: string, url: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function send(url: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new HttpError(`request to ${url} failed: ${describeError(error)}`, url, undefined, {
      cause: error,
    });
  }
}

/** Performs a request and parses the JSON body. Throws {@link HttpError} on non-2xx statuses. */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(
      `${options.method ?? "GET"} ${url} returned ${String(response.status)}: ${text.slice(0, 300)}`,
      url,
      response.status,
    );
  }
  if (text.length === 0) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new HttpError(`invalid JSON from ${url}`, url, response.status, { cause: error });
  }
}

/** Performs a request where only success matters. Throws {@link HttpError} on non-2xx statuses. */
export async function requestOk(url: string, options: RequestOptions = {}): Promise<void> {
  const response = await send(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(
      `${options.method ?? "GET"} ${url} returned ${String(response.status)}: ${text.slice(0, 300)}`,
      url,
      response.status,
    );
  }
  await response.body?.cancel();
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}
