import { setTimeout as wait } from "node:timers/promises";
import type { StandbyReaderStatus, StandbySource } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import type { DecodeCheck, DecodeChecker } from "./decode-check.ts";
import { DEFAULT_LIVE_EDGE_SETTINGS, LiveEdge, type LiveEdgeSettings, type WatchLiveEdge } from "./live-edge.ts";
import { TsPackets } from "./ts-packets.ts";

export interface StandbyReaderSettings {
  /** A connection that brings no data for this long is dropped and opened again. */
  idleTimeoutMs: number;
  /** Wait between two connections after one ended or failed. */
  retryMs: number;
  /**
   * How long a reader that lets go of its source for ffmpeg waits after closing the connection,
   * so that the engine notices before ffmpeg connects (it allows one reader per session).
   */
  releaseGraceMs?: number;
}

export const DEFAULT_STANDBY_READER_SETTINGS: StandbyReaderSettings = {
  idleTimeoutMs: 30_000,
  retryMs: 2000,
  releaseGraceMs: 500,
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** What a reader works with besides its settings. */
interface ReaderDeps {
  fetch: Fetch;
  now: () => number;
  liveEdge: StandbyLiveEdge | undefined;
  decoder: DecodeChecker | undefined;
}

/** A connection that brought this much without one MPEG-TS packet of stream data gets a warning. */
const NOT_VIDEO_WARN_BYTES = 1024 * 1024;

/** How standby readers follow their sessions' live edges (see `LiveEdge`). */
export interface StandbyLiveEdge {
  watch: WatchLiveEdge;
  liveEdge?: LiveEdgeSettings | undefined;
}

/**
 * Reads one standby session's playback URL and throws the data away, so the engine keeps pulling
 * the stream from its peers as if a player were watching. Video goes nowhere: only the time of the
 * last data counts, which tells the controller that the standby is hot. A connection that ends,
 * fails or goes quiet is opened again.
 *
 * Only MPEG-TS packets that carry stream data count as data (see `TsPackets`): an engine can
 * send bytes that aren't video, such as zeros, and a standby that only has those can't take over.
 * With a decode checker, ffmpeg also has to decode video from the data (see `createDecodeChecker`):
 * when the data starts to come, and again every so often. Until a check passes, or once one fails,
 * the data doesn't count.
 *
 * With the session's stat URL, only data that comes while its live edge moves counts: an engine
 * whose broadcast stopped still serves the old window it has, which would make it look hot.
 */
class StandbyReader {
  readonly source: string;
  private readonly watch: { readonly edge: LiveEdge; stop: () => void } | undefined;
  private readonly settings: StandbyReaderSettings;
  private readonly logger: Logger;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly closed = new AbortController();
  /** Settles once the reader stopped for good, its last connection closed. */
  private readonly done: Promise<void>;
  private attempt: AbortController | undefined;
  private state: StandbyReaderStatus["state"] = "connecting";
  private bytes = 0;
  private lastDataAt: number | undefined;
  private error: string | null = null;
  private readonly decoder: DecodeChecker | undefined;
  /** Whether the last decode check found video; undefined before the first one ended. */
  private decodes: boolean | undefined;
  private check: DecodeCheck | undefined;
  private nextCheckAt = 0;

  constructor(source: StandbySource, settings: StandbyReaderSettings, logger: Logger, deps: ReaderDeps) {
    const { liveEdge, now } = deps;
    this.source = source.source;
    this.settings = settings;
    this.logger = logger;
    this.fetch = deps.fetch;
    this.now = now;
    this.decoder = deps.decoder;
    this.watch =
      source.stat === undefined || liveEdge === undefined
        ? undefined
        : liveEdge.watch(source.stat, new LiveEdge(liveEdge.liveEdge ?? DEFAULT_LIVE_EDGE_SETTINGS, now));
    this.done = this.run();
  }

  status(): StandbyReaderStatus {
    return {
      source: this.source,
      state: this.state,
      bytes: this.bytes,
      lastDataAt: this.lastDataAt === undefined ? null : new Date(this.lastDataAt).toISOString(),
      error: this.error,
      liveEdge: this.watch?.edge.view() ?? null,
    };
  }

  /**
   * Stops reading at once, closing the connection: the engine allows one reader per session.
   * Settles once the connection is closed.
   */
  async close(): Promise<void> {
    this.closed.abort();
    this.attempt?.abort();
    this.watch?.stop();
    this.check?.stop();
    await this.done;
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
    const packets = new TsPackets();
    let withoutVideo = 0;
    try {
      // The playback URL redirects to the stream itself.
      const response = await this.fetch(this.source, { signal: attempt.signal, redirect: "follow" });
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new Error(`the engine answered ${String(response.status)}`);
      }
      for await (const chunk of response.body) {
        this.bytes += (chunk as Uint8Array).byteLength;
        const video = packets.push(chunk as Uint8Array) > 0;
        if (video) {
          this.decodeCheck(chunk as Uint8Array);
        }
        const decodes = this.decoder === undefined || this.decodes === true;
        if (video && decodes && (this.watch === undefined || this.watch.edge.publishable())) {
          this.lastDataAt = this.now();
        }
        this.state = "receiving";
        this.error = this.decodes === false ? "ffmpeg decoded no video from it" : null;
        const before = withoutVideo;
        withoutVideo = video ? 0 : withoutVideo + (chunk as Uint8Array).byteLength;
        if (withoutVideo >= NOT_VIDEO_WARN_BYTES) {
          this.error = "the engine sends data that isn't MPEG-TS video";
          if (before < NOT_VIDEO_WARN_BYTES) {
            this.logger.warn(
              { source: this.source, bytes: withoutVideo },
              "standby gets data that isn't MPEG-TS video",
            );
          }
        }
        arm();
      }
    } catch (error) {
      throw attempt.signal.aborted && !this.closed.signal.aborted ? (attempt.signal.reason as Error) : error;
    } finally {
      clearTimeout(timer);
      attempt.abort();
      // A check needs data that follows on; the next connection starts one of its own.
      this.check?.stop();
    }
  }

  /** Feeds the running decode check, or starts one when it is time and a check is free. */
  private decodeCheck(chunk: Uint8Array): void {
    if (this.decoder === undefined) {
      return;
    }
    if (this.check === undefined && this.now() >= this.nextCheckAt) {
      const check = this.decoder.start();
      if (check !== undefined) {
        this.check = check;
        void check.result.then((decoded) => {
          this.checked(check, decoded);
        });
      }
    }
    this.check?.feed(chunk);
  }

  private checked(check: DecodeCheck, decoded: boolean): void {
    if (this.check !== check) {
      return;
    }
    this.check = undefined;
    // A check stopped with its connection, or by close(), says nothing about the video.
    if (this.isClosed() || this.attempt?.signal.aborted !== false) {
      return;
    }
    const settings = this.decoder?.settings;
    this.nextCheckAt = this.now() + (decoded ? (settings?.intervalMs ?? 0) : (settings?.retryMs ?? 0));
    if (this.decodes !== decoded) {
      if (decoded) {
        this.logger.info({ source: this.source }, "standby video decodes");
      } else {
        this.logger.warn({ source: this.source }, "ffmpeg decoded no video from the standby");
      }
    }
    this.decodes = decoded;
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
  private readonly liveEdge: StandbyLiveEdge | undefined;
  private readonly decoder: DecodeChecker | undefined;

  constructor(
    logger: Logger,
    settings: StandbyReaderSettings = DEFAULT_STANDBY_READER_SETTINGS,
    fetchImpl: Fetch = fetch,
    now: () => number = Date.now,
    liveEdge?: StandbyLiveEdge,
    decoder?: DecodeChecker,
  ) {
    this.logger = logger;
    this.settings = settings;
    this.fetch = fetchImpl;
    this.now = now;
    this.liveEdge = liveEdge;
    this.decoder = decoder;
  }

  /** Reads exactly these sources from now on (a bare URL is a source without a stat URL). */
  set(sources: readonly (string | StandbySource)[]): StandbyReaderStatus[] {
    const wanted = sources.map((source) => (typeof source === "string" ? { source } : source));
    for (const [source, reader] of this.readers) {
      if (wanted.every((candidate) => candidate.source !== source)) {
        void reader.close();
        this.readers.delete(source);
      }
    }
    for (const source of wanted) {
      if (!this.readers.has(source.source)) {
        const reader = new StandbyReader(source, this.settings, this.logger, {
          fetch: this.fetch,
          now: this.now,
          liveEdge: this.liveEdge,
          decoder: this.decoder,
        });
        this.readers.set(source.source, reader);
      }
    }
    return this.status();
  }

  /**
   * Stops reading a source that ffmpeg reads from now on: the engine allows one reader per
   * session. Settles once the connection is closed and the engine had a moment to notice, with
   * true when the source had a reader.
   */
  async release(source: string): Promise<boolean> {
    const reader = this.readers.get(source);
    if (reader === undefined) {
      return false;
    }
    this.readers.delete(source);
    await reader.close();
    await wait(this.settings.releaseGraceMs ?? 0);
    return true;
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
      void reader.close();
    }
    this.readers.clear();
  }
}
