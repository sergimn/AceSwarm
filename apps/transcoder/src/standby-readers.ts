import type { StandbyReaderStatus } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";

export interface StandbyReaderSettings {
  /** A connection that brings no data for this long is dropped and opened again. */
  idleTimeoutMs: number;
  /** Wait between two connections after one ended or failed. */
  retryMs: number;
}

export const DEFAULT_STANDBY_READER_SETTINGS: StandbyReaderSettings = { idleTimeoutMs: 30_000, retryMs: 2000 };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Reads one standby session's playback URL and throws the data away, so the engine keeps pulling
 * the stream from its peers as if a player were watching. Video goes nowhere: only the time of the
 * last data counts, which tells the controller that the standby is hot. A connection that ends,
 * fails or goes quiet is opened again.
 */
class StandbyReader {
  readonly source: string;
  private readonly settings: StandbyReaderSettings;
  private readonly logger: Logger;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly closed = new AbortController();
  private attempt: AbortController | undefined;
  private state: StandbyReaderStatus["state"] = "connecting";
  private bytes = 0;
  private lastDataAt: number | undefined;
  private error: string | null = null;

  constructor(source: string, settings: StandbyReaderSettings, logger: Logger, fetch: Fetch, now: () => number) {
    this.source = source;
    this.settings = settings;
    this.logger = logger;
    this.fetch = fetch;
    this.now = now;
    void this.run();
  }

  status(): StandbyReaderStatus {
    return {
      source: this.source,
      state: this.state,
      bytes: this.bytes,
      lastDataAt: this.lastDataAt === undefined ? null : new Date(this.lastDataAt).toISOString(),
      error: this.error,
    };
  }

  /** Stops reading at once, closing the connection: the engine allows one reader per stream. */
  close(): void {
    this.closed.abort();
    this.attempt?.abort();
  }

  /** A method, so that a check after an `await` sees `close()` calls made meanwhile. */
  private isClosed(): boolean {
    return this.closed.signal.aborted;
  }

  private async run(): Promise<void> {
    while (!this.isClosed()) {
      this.state = "connecting";
      try {
        await this.readOnce();
        this.error = "the engine ended the stream";
      } catch (error) {
        if (this.isClosed()) {
          return;
        }
        this.error = describeError(error);
      }
      this.state = "waiting";
      this.logger.debug({ source: this.source, error: this.error }, "standby reader disconnected; connecting again");
      await abortableSleep(this.settings.retryMs, this.closed.signal);
    }
  }

  /** One connection, until it ends, fails or brings no data for the idle timeout. */
  private async readOnce(): Promise<void> {
    const attempt = new AbortController();
    this.attempt = attempt;
    let timer: NodeJS.Timeout | undefined;
    const idle = `no data for ${String(Math.round(this.settings.idleTimeoutMs / 1000))}s`;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        attempt.abort(new Error(idle));
      }, this.settings.idleTimeoutMs);
      timer.unref();
    };
    arm();
    try {
      // The playback URL redirects to the stream itself.
      const response = await this.fetch(this.source, { signal: attempt.signal, redirect: "follow" });
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new Error(`the engine answered ${String(response.status)}`);
      }
      for await (const chunk of response.body) {
        this.bytes += (chunk as Uint8Array).byteLength;
        this.lastDataAt = this.now();
        this.state = "receiving";
        this.error = null;
        arm();
      }
    } catch (error) {
      throw attempt.signal.aborted && !this.closed.signal.aborted ? (attempt.signal.reason as Error) : error;
    } finally {
      clearTimeout(timer);
      attempt.abort();
    }
  }
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The standby readers of one stream, one per standby session on another network path. The
 * controller sends the complete list on every check; readers it no longer lists stop.
 */
export class StandbyReaders {
  private readonly readers = new Map<string, StandbyReader>();
  private readonly settings: StandbyReaderSettings;
  private readonly logger: Logger;
  private readonly fetch: Fetch;
  private readonly now: () => number;

  constructor(
    logger: Logger,
    settings: StandbyReaderSettings = DEFAULT_STANDBY_READER_SETTINGS,
    fetchImpl: Fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.logger = logger;
    this.settings = settings;
    this.fetch = fetchImpl;
    this.now = now;
  }

  /** Reads exactly these sources from now on. */
  set(sources: readonly string[]): StandbyReaderStatus[] {
    for (const [source, reader] of this.readers) {
      if (!sources.includes(source)) {
        reader.close();
        this.readers.delete(source);
      }
    }
    for (const source of sources) {
      if (!this.readers.has(source)) {
        this.readers.set(source, new StandbyReader(source, this.settings, this.logger, this.fetch, this.now));
      }
    }
    return this.status();
  }

  /** Stops reading a source that ffmpeg now reads: the engine allows one reader per stream. */
  release(source: string): void {
    this.readers.get(source)?.close();
    this.readers.delete(source);
  }

  status(): StandbyReaderStatus[] {
    return this.readers
      .values()
      .map((reader) => reader.status())
      .toArray();
  }

  get size(): number {
    return this.readers.size;
  }

  closeAll(): void {
    for (const reader of this.readers.values()) {
      reader.close();
    }
    this.readers.clear();
  }
}
