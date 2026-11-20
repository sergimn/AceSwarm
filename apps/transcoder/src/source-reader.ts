import { setTimeout as wait } from "node:timers/promises";
import { describeError } from "@aceswarm/shared/http";
import { PACKET_BYTES, TsPackets } from "./ts-packets.ts";
import { streamPids, TsTables, type Layout } from "./ts-tables.ts";

/** Where a reader sends the stream it reads: the input of an ffmpeg run. */
export interface Sink {
  /** Takes the next bytes. Settles once more may come: the engine is read no faster than ffmpeg takes it. */
  write: (bytes: Uint8Array) => Promise<void>;
  /** Nothing more comes: ffmpeg writes out what it has, and ends. */
  end: () => void;
}

/** For a run whose ffmpeg has not started: takes nothing. */
export const NO_SINK: Sink = { write: () => Promise.resolve(), end: () => undefined };

/** The stream's layout became known (`previous` is undefined), or changed. */
export interface LayoutChange {
  layout: Layout;
  previous: Layout | undefined;
  /** Whether the sink already got some of the stream: if so, the reader ends it when another takes over. */
  delivered: boolean;
}

/** Why a reader is done with its source. */
export interface SourceEnd {
  reason: string;
  /** Whether the sink it fed last got any of the stream. */
  delivered: boolean;
}

export interface SourceRequest {
  /** The engine's playback URL. */
  source: string;
  /** Gives up after this long without data, as on a session that never gets ready. */
  idleTimeoutMs: number;
  /** How long after an engine said it isn't ready it is asked again: a second, unless a test says otherwise. */
  retryMs?: number;
  sink: Sink;
  /**
   * Called when the stream's layout becomes known or changes (see `LayoutChange`), before the
   * bytes that follow it. Returns the sink for those: another one to start a new ffmpeg run on the
   * new layout, or undefined to go on with the same.
   */
  onLayout: (change: LayoutChange) => Sink | undefined;
  /** The reader is done: the engine ended the stream, the connection failed, or nothing came for too long. */
  onEnd: (end: SourceEnd) => void;
}

export interface SourceReader {
  /** Closes the connection at once. Nothing is reported after it. */
  stop: () => void;
}

/** Starts reading a source; replaceable in tests. */
export type OpenSource = (request: SourceRequest) => SourceReader;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** An engine that isn't ready to serve its session yet is asked again after this long. */
const NOT_READY_RETRY_MS = 1000;
/** Bytes without one MPEG-TS packet after which a source counts as some other format, passed on as it comes. */
const FORMAT_PATIENCE_BYTES = 64 * 1024;
/**
 * How much of an MPEG-TS stream is held back for its program tables. They come several times a
 * second, so only a stream that has none gets here; it is passed on without a known layout.
 */
const TABLES_PATIENCE_BYTES = 2 * 1024 * 1024;
/**
 * A stream whose layout changes again this soon after ffmpeg started over on it waits until then,
 * and gets the layout it has by then. A change is followed at once; tables that flip on after it
 * start ffmpeg once more, for what they say when the wait is over, not at every flip.
 */
const MIN_FOLLOW_INTERVAL_MS = 3000;
/**
 * Tables that said the same for this long have settled. Until they do, every change that is
 * followed doubles the wait above, up to this long: tables that never settle get a new ffmpeg
 * run once a minute in the end, not every three seconds for as long as they go on.
 */
const SETTLED_MS = 60_000;
const NULL_PID = 0x1f_ff;
/** What an engine says instead of video is short; more than this of it tells nothing. */
const MAX_ANSWER_BYTES = 200;

type Piece = { sink: Sink; bytes: Uint8Array } | { sink: Sink; end: true };

/**
 * Reads an engine session's playback URL for ffmpeg and passes the stream on to it. ffmpeg used
 * to read the URL itself; reading it here shows what the broadcast sends before ffmpeg gets it:
 *
 * - An MPEG-TS stream's program tables are followed (see `TsTables`). When the broadcast changes
 *   its layout mid-stream (its video moves to another PID, or to another codec) an ffmpeg run that
 *   began on the old layout gets no more video: it stays on the streams it found at its start. The
 *   reader's owner is told right where the change is in the stream and can hand over a new sink:
 *   the old run's input ends there, so it writes out its last frames, and the new run begins with
 *   the stream's tables followed by everything after the change. Neither run misses a byte of
 *   its layout, and the engine's session stays as it is. Packets on PIDs that only the old layout
 *   had are left out from then on, as they would only look like more streams to the new run.
 * - The first tables come before any of the stream is passed on, so the owner can start the right
 *   kind of ffmpeg run for what the stream carries before it reads a byte.
 * - An engine that is not ready to serve its session answers with a short text instead of video
 *   ("failed to seek"), which ffmpeg takes for invalid data. The reader asks again every second
 *   for as long as it would wait for data, without an ffmpeg run failing each time.
 *
 * Anything that is not MPEG-TS is passed on as it comes. The engine allows one reader per session.
 */
class EngineReader implements SourceReader {
  private readonly request: SourceRequest;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly closed = new AbortController();
  private sink: Sink;
  private format: "unknown" | "mpegts" | "other" = "unknown";
  /** What came while the format was unknown. */
  private undecided: Uint8Array[] = [];
  private undecidedBytes = 0;
  private readonly scout = new TsPackets();
  private readonly packets = new TsPackets();
  private readonly tables = new TsTables();
  /** The stream so far, held back until its first tables came (see `TABLES_PATIENCE_BYTES`). */
  private early: Uint8Array[] | undefined = [];
  private earlyBytes = 0;
  /** The layout the sink's run reads, once known. */
  private fed: Layout | undefined;
  private followedAt = -Infinity;
  /** How many changes were followed since the tables last settled (see `SETTLED_MS`), and when they last changed. */
  private restless = 0;
  private changedAt = -Infinity;
  /** PIDs of a layout the stream left, which the new one doesn't use. */
  private dropped = new Set<number>();
  private delivered = false;

  constructor(request: SourceRequest, fetchImpl: Fetch, now: () => number) {
    this.request = request;
    this.fetch = fetchImpl;
    this.now = now;
    this.sink = request.sink;
    void this.run();
  }

  stop(): void {
    this.closed.abort();
  }

  /** A method, so that a check after an `await` sees `stop()` calls made meanwhile. */
  private stopped(): boolean {
    return this.closed.signal.aborted;
  }

  private async run(): Promise<void> {
    let reason: string;
    try {
      reason = await this.read();
      // What was held back for a decision that never came is all there is: ffmpeg gets to try it.
      await this.release();
    } catch (error) {
      reason = describeError(error);
    }
    if (!this.stopped()) {
      this.request.onEnd({ reason, delivered: this.delivered });
    }
  }

  /** Reads the source until it ends, asking again while the engine isn't ready. Returns why it ended. */
  private async read(): Promise<string> {
    const since = this.now();
    const retryMs = this.request.retryMs ?? NOT_READY_RETRY_MS;
    for (;;) {
      const outcome = await this.connect();
      const waited = this.now() - since;
      if (outcome.ready || this.stopped() || waited + retryMs >= this.request.idleTimeoutMs) {
        return outcome.reason;
      }
      await wait(retryMs, undefined, { signal: this.closed.signal }).catch(() => undefined);
      if (this.stopped()) {
        return outcome.reason;
      }
    }
  }

  /** One connection. `ready` is false when the engine answered that it has no video to serve yet. */
  private async connect(): Promise<{ ready: boolean; reason: string }> {
    if (this.stopped()) {
      return { ready: true, reason: "stopped" };
    }
    const attempt = new AbortController();
    const abort = (): void => {
      attempt.abort();
    };
    this.closed.signal.addEventListener("abort", abort, { once: true });
    const idle = `no data from the engine for ${String(Math.round(this.request.idleTimeoutMs / 1000))}s`;
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        attempt.abort(new Error(idle));
      }, this.request.idleTimeoutMs);
      timer.unref();
    };
    arm();
    try {
      // The playback URL redirects to the stream itself.
      const response = await this.fetch(this.request.source, { signal: attempt.signal, redirect: "follow" });
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        return { ready: true, reason: `the engine answered ${String(response.status)}` };
      }
      if (/^text\//i.test(response.headers.get("content-type") ?? "")) {
        return { ready: false, reason: `the engine answered "${await answerOf(response)}" instead of video` };
      }
      for await (const chunk of response.body) {
        // While ffmpeg is taking the data, the engine isn't the one keeping us waiting.
        clearTimeout(timer);
        await this.take(chunk as Uint8Array);
        if (this.stopped()) {
          break;
        }
        arm();
      }
      return { ready: true, reason: "the engine ended the stream" };
    } catch (error) {
      if (attempt.signal.aborted && !this.stopped() && attempt.signal.reason instanceof Error) {
        return { ready: true, reason: attempt.signal.reason.message };
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.closed.signal.removeEventListener("abort", abort);
      attempt.abort();
    }
  }

  private async take(chunk: Uint8Array): Promise<void> {
    if (this.format === "other") {
      await this.pass(this.sink, chunk);
      return;
    }
    if (this.format === "mpegts") {
      await this.send(this.sort(chunk));
      return;
    }
    this.undecided.push(chunk);
    this.undecidedBytes += chunk.byteLength;
    let packets = 0;
    this.scout.push(chunk, () => {
      packets += 1;
    });
    if (packets > 0) {
      this.format = "mpegts";
      const held = this.undecided;
      this.undecided = [];
      for (const part of held) {
        await this.send(this.sort(part));
      }
    } else if (this.undecidedBytes >= FORMAT_PATIENCE_BYTES) {
      this.format = "other";
      await this.release();
    }
  }

  /** Passes on what was held back: for a format still unknown, or for tables that didn't come. */
  private async release(): Promise<void> {
    const held = [...this.undecided, ...(this.early ?? [])];
    this.undecided = [];
    this.early = undefined;
    for (const part of held) {
      await this.pass(this.sink, part);
    }
  }

  /**
   * Walks the packets a chunk completes and sorts them into pieces for the sinks, in order: the
   * current run's, and from a layout change on the next run's, with the tables in front.
   */
  private sort(chunk: Uint8Array): Piece[] {
    const out: Piece[] = [];
    let data = chunk;
    let from = -1;
    let to = -1;
    const flush = (): void => {
      if (from < 0) {
        return;
      }
      const bytes = data.subarray(from, to);
      from = -1;
      if (this.early === undefined) {
        out.push({ sink: this.sink, bytes });
        return;
      }
      this.early.push(bytes);
      this.earlyBytes += bytes.byteLength;
    };
    // A change that came too soon after the last one is followed now, with the layout as it is by now.
    if (this.fed !== undefined && this.mayFollow()) {
      this.follow(this.tables.layout, out);
    }
    this.packets.push(chunk, (buffer, at) => {
      data = buffer;
      const pid = (((buffer[at + 1] ?? 0) & 0x1f) << 8) | (buffer[at + 2] ?? 0);
      const layout = this.tables.packet(buffer, at);
      if (layout !== undefined) {
        // Tables that held long enough before this have settled: the waits start over.
        this.restless = this.now() - this.changedAt >= SETTLED_MS ? 0 : this.restless;
        this.changedAt = this.now();
      }
      if (layout !== undefined && (this.fed === undefined || this.mayFollow())) {
        flush();
        this.follow(layout, out);
      }
      if (pid === NULL_PID || this.dropped.has(pid)) {
        // Padding carries nothing, and a PID the stream left would look like one more stream.
        flush();
        return;
      }
      if (from >= 0 && at === to) {
        to += PACKET_BYTES;
        return;
      }
      flush();
      from = at;
      to = at + PACKET_BYTES;
    });
    flush();
    if (this.early !== undefined && this.earlyBytes >= TABLES_PATIENCE_BYTES) {
      // No tables: the stream goes on as it comes, and ffmpeg makes of it what it can.
      out.push(...this.early.map((bytes) => ({ sink: this.sink, bytes })));
      this.early = undefined;
    }
    return out;
  }

  /** Whether a change of layout is followed now: the last one that was is long enough ago. */
  private mayFollow(): boolean {
    const wait = Math.min(MIN_FOLLOW_INTERVAL_MS * 2 ** Math.max(this.restless - 1, 0), SETTLED_MS);
    return this.now() - this.followedAt >= wait;
  }

  /**
   * The stream's layout is `layout` from here on. Asks the owner for the sink of what follows; with
   * another one, the old one ends here and the new one begins with the stream's tables.
   */
  private follow(layout: Layout | undefined, out: Piece[]): void {
    if (layout === undefined || layout.key === this.fed?.key) {
      return;
    }
    const previous = this.fed;
    const next = this.request.onLayout({ layout, previous, delivered: this.delivered });
    this.restless += previous === undefined ? 0 : 1;
    this.fed = layout;
    this.followedAt = this.now();
    const held = this.early ?? [];
    this.early = undefined;
    if (next !== undefined && next !== this.sink) {
      if (this.delivered) {
        out.push({ sink: this.sink, end: true });
      }
      const kept = streamPids(layout);
      this.dropped = new Set(previous === undefined ? [] : streamPids(previous).difference(kept));
      this.sink = next;
      this.delivered = false;
    }
    if (next !== undefined || previous === undefined) {
      // A run that starts here knows the layout from its first bytes, wherever in the stream it is.
      out.push({ sink: this.sink, bytes: this.tables.tablePackets() });
    }
    out.push(...held.map((bytes) => ({ sink: this.sink, bytes })));
  }

  private async send(pieces: Piece[]): Promise<void> {
    for (const piece of pieces) {
      if (this.stopped()) {
        return;
      }
      if ("end" in piece) {
        piece.sink.end();
      } else {
        await this.pass(piece.sink, piece.bytes);
      }
    }
  }

  private async pass(sink: Sink, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0 || this.stopped()) {
      return;
    }
    if (sink === this.sink) {
      this.delivered = true;
    }
    await sink.write(bytes);
  }
}

/** The start of what an engine answered instead of video, as text. */
async function answerOf(response: Response): Promise<string> {
  let text = "";
  const body = response.body ?? [];
  try {
    for await (const chunk of body) {
      text += Buffer.from(chunk as Uint8Array).toString("utf8");
      if (text.length >= MAX_ANSWER_BYTES) {
        await response.body?.cancel();
        break;
      }
    }
  } catch {
    // Whatever came of it is enough.
  }
  return text.slice(0, MAX_ANSWER_BYTES).replaceAll(/\s+/g, " ").trim();
}

/** Reads `request.source` (see `EngineReader`). */
export function readSource(
  request: SourceRequest,
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): SourceReader {
  return new EngineReader(request, fetchImpl, now);
}
