import { setTimeout as wait } from "node:timers/promises";
import { describeError } from "@aceswarm/shared/http";
import { CutPointHold, type HeldUnit } from "./cut-point-hold.ts";
import { FollowBrake } from "./follow-brake.ts";
import type { CutPoint } from "./h264-cut-points.ts";
import { PidMoves, type PacketVerdict } from "./pid-moves.ts";
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
  /**
   * Why the sink's run can't read on over the change (see `PidMoves`), where it might have: it
   * had some of the stream, which then changed.
   */
  unfit?: string | undefined;
}

/** A change of layout that the sink's run reads on over (see `PidMoves`). */
export interface LayoutMove {
  layout: Layout;
  previous: Layout;
  /**
   * The streams the run's ffmpeg reads are where they were, so nothing changed in what it gets:
   * the tables changed alone, or streams it doesn't read came or went (see `staysPut`).
   */
  inPlace: boolean;
}

/**
 * Lets a run that re-encodes the stream's H.264 video hand over to one that copies it, right at an
 * access unit where ffmpeg can cut a copy (see `cutPointOf`).
 */
export interface CutPoints {
  /** Asked at the start of each access unit of the run's video: whether to look whether a copy can be cut at it. */
  watching: () => boolean;
  /**
   * One that can came, with its PES's time stamp, and what kind of picture it is. Returns the sink
   * of what follows, from that unit on, to start a new ffmpeg run there, or undefined to go on
   * with the same.
   */
  found: (pts: number | undefined, point: Exclude<CutPoint, "none">) => Sink | undefined;
}

/** Why a reader is done with its source. */
export interface SourceEnd {
  reason: string;
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
  /**
   * The broadcast moved its streams to other PIDs, or left the ones the run reads where they were
   * (`inPlace`), and the sink's run reads on as it is (see `PidMoves`): `onLayout` is not asked.
   */
  onMove?: (change: LayoutMove) => void;
  /** Looks for where a copy of the run's video can begin (see `CutPoints`), while it says so. */
  cutPoints?: CutPoints;
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
 * - A change that only moves the streams to other PIDs needs no new run: their packets are passed
 *   on under the PIDs ffmpeg knows, once the stream has shown that the decoders can go on with
 *   them (see `PidMoves`). The owner is told (`onMove`), not asked.
 * - While the owner watches for them (see `CutPoints`), the start of each access unit of the
 *   run's H.264 video is held back until it shows whether ffmpeg can cut a copy of it there (see
 *   `CutPointHold`). At one it can, the owner may hand over a new sink as at a change of layout:
 *   the old run's input ends right before that unit, and the new run begins with the tables and
 *   then the unit.
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
  /** Holds back how often a new run starts for tables that keep changing. */
  private readonly brake: FollowBrake;
  /** The PIDs that carried packets since a change began to wait its turn, while it waits. */
  private heard: Set<number> | undefined;
  /** PIDs of a layout the stream left, which the new one doesn't use. */
  private dropped = new Set<number>();
  private readonly moves: PidMoves;
  /** The layout of a move that is being looked at (see `PidMoves.consider`): until it is decided, the run reads `fed`. */
  private looking: Layout | undefined;
  private readonly cuts = new CutPointHold();
  private readonly watchingCuts = (): boolean => this.request.cutPoints?.watching() === true;
  private delivered = false;

  constructor(request: SourceRequest, fetchImpl: Fetch, now: () => number) {
    this.request = request;
    this.fetch = fetchImpl;
    this.now = now;
    this.brake = new FollowBrake(now);
    this.moves = new PidMoves(now);
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
      this.request.onEnd({ reason });
    }
  }

  /** Reads the source until it ends, asking again while the engine isn't ready. Returns why it ended. */
  private async read(): Promise<string> {
    const since = this.now();
    const retryMs = this.request.retryMs ?? NOT_READY_RETRY_MS;
    for (;;) {
      // A reader that was stopped connects no more: `connect` ends the asking.
      const outcome = await this.connect();
      const waited = this.now() - since;
      if (outcome.ready || waited + retryMs >= this.request.idleTimeoutMs) {
        return outcome.reason;
      }
      await wait(retryMs, undefined, { signal: this.closed.signal }).catch(() => undefined);
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
    if (this.stopped()) {
      // Its owner let go of it, and a chunk that was already on its way still came in: no layout
      // is followed on it, which would start an ffmpeg run for a stream that stopped.
      return;
    }
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

  /** Passes on what was held back: for a format still unknown, for tables that didn't come, or for a cut point. */
  private async release(): Promise<void> {
    const out: Piece[] = [];
    this.letGo(out);
    await this.send(out);
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
    const late = this.moves.expire();
    if (late !== undefined) {
      this.settle(late, out);
    }
    // A change that came too soon after the last one is followed now, with the layout as it is by now.
    if (this.fed !== undefined && this.brake.mayFollow()) {
      this.follow(this.tables.layout, out, this.waited());
    }
    this.packets.push(chunk, (buffer, at) => {
      data = buffer;
      const pid = (((buffer[at + 1] ?? 0) & 0x1f) << 8) | (buffer[at + 2] ?? 0);
      const layout = this.tables.packet(buffer, at);
      if (layout !== undefined) {
        this.brake.changed();
      }
      if (layout !== undefined && (this.fed === undefined || this.brake.mayFollow())) {
        flush();
        this.follow(layout, out, this.waited());
      } else if (layout !== undefined) {
        // It waits its turn: what comes meanwhile tells whether the run could still read on over it.
        this.heard ??= new Set();
      }
      this.heard?.add(pid);
      if (pid === NULL_PID || this.dropped.has(pid)) {
        // Padding carries nothing, and a PID the stream left would look like one more stream.
        flush();
        return;
      }
      const held = this.holdForCut(buffer, at, pid);
      if (held !== "pass") {
        flush();
        if (held !== "held") {
          this.cutPoint(held, out);
        }
        return;
      }
      const verdict = this.moves.packet(buffer, at, pid, this.tables.carriesTables(pid));
      if (verdict !== "pass") {
        flush();
        this.settle(verdict, out);
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

  /** The PIDs that carried packets while a change waited its turn, if one did: it is followed now. */
  private waited(): ReadonlySet<number> | undefined {
    const { heard } = this;
    this.heard = undefined;
    return heard;
  }

  /**
   * The stream's layout is `layout` from here on. A run that can read on over the change does (see
   * `PidMoves`); otherwise a new one starts here (see `startOver`). A change that waited for its
   * turn (see `FollowBrake`; `waited` has the PIDs that carried packets meanwhile) gets a new run
   * unless the run's streams are where they were, or nothing came on the PIDs it moves them to: the
   * old one was given the stream as it came meanwhile, so it is not where a move could take it on from.
   */
  private follow(layout: Layout | undefined, out: Piece[], waited: ReadonlySet<number> | undefined): void {
    const previous = this.fed;
    if (layout === undefined || layout.key === (this.looking ?? previous)?.key) {
      return;
    }
    // What was held back for a cut point belongs to the layout the run reads.
    this.letGo(out);
    // A move that was still being looked at is off: the stream changed again.
    const held = this.moves.giveUp();
    if (this.looking !== undefined) {
      this.dropped = this.dropped.union(streamPids(this.looking)).difference(streamPids(layout));
      this.looking = undefined;
    }
    // Back to what the run reads, or on to another layout.
    if (layout.key !== previous?.key) {
      this.decide(layout, previous, out, waited);
    }
    this.again(held, out);
  }

  /** Whether the run reads on over the change to `layout`, and how; a new one starts here otherwise. */
  private decide(
    layout: Layout,
    previous: Layout | undefined,
    out: Piece[],
    waited: ReadonlySet<number> | undefined,
  ): void {
    const fit = previous === undefined ? undefined : this.moves.consider(layout, waited);
    if (fit === "carried" && previous !== undefined) {
      this.fed = layout;
      this.request.onMove?.({ layout, previous, inPlace: true });
    } else if (fit === "looking") {
      this.looking = layout;
      // PIDs the stream left earlier may be the ones it is on now.
      this.dropped = this.dropped.difference(streamPids(layout));
    } else {
      this.startOver({ layout, previous, unfit: typeof fit === "object" ? fit.no : undefined }, [], out);
    }
  }

  /**
   * What was held for a move that is off takes the way of any packet now, late but in order. The
   * layout that follows may well have those PIDs too (tables that gain a stream a moment after a
   * new encoder came up), and whichever run reads on needs what came on them: the key picture
   * that was held is where its video starts.
   */
  private again(held: readonly Uint8Array[], out: Piece[]): void {
    for (const bytes of held) {
      const pid = (((bytes[1] ?? 0) & 0x1f) << 8) | (bytes[2] ?? 0);
      const left = this.dropped.has(pid);
      const verdict = left ? "drop" : this.moves.packet(bytes, 0, pid, this.tables.carriesTables(pid));
      if (verdict === "pass") {
        out.push({ sink: this.sink, bytes });
      } else {
        this.settle(verdict, out);
      }
    }
  }

  /**
   * Holds the packet back while the start of an access unit of the run's video shows whether a
   * copy can be cut at it (see `CutPointHold`); not while the stream's first tables or a move are
   * awaited.
   */
  private holdForCut(data: Uint8Array, at: number, pid: number): ReturnType<CutPointHold["packet"]> {
    const { fed } = this;
    const waiting = this.early !== undefined || this.looking !== undefined;
    return this.request.cutPoints === undefined || fed === undefined || waiting
      ? "pass"
      : this.cuts.packet(data, at, pid, fed, this.watchingCuts);
  }

  /**
   * An access unit of the run's video that was held back tells whether a copy can be cut at it. At
   * one that can, the owner may hand over another sink: the old one ends right before the unit, and
   * the new one begins with the stream's tables and then the unit, as at a change of layout.
   * Otherwise the unit goes on as it would have. The owner isn't asked while the tables name
   * another layout than the run reads (a change that waits its turn, see `FollowBrake`): a new run
   * would begin with those tables while the stream still comes as the run reads it.
   */
  private cutPoint(unit: HeldUnit, out: Piece[]): void {
    const { point } = unit;
    const { fed } = this;
    const asRead = fed !== undefined && this.tables.layout?.key === fed.key;
    const next = point === "none" || !asRead ? undefined : this.request.cutPoints?.found(unit.pts, point);
    if (next === undefined || next === this.sink || fed === undefined) {
      this.again(unit.packets, out);
      return;
    }
    if (this.delivered) {
      out.push({ sink: this.sink, end: true });
    }
    this.sink = next;
    this.delivered = false;
    out.push({ sink: next, bytes: this.tables.tablePackets() });
    // The new run reads the stream as it comes, from this unit on.
    this.moves.begin(fed, unit.packets);
    out.push({ sink: next, bytes: Buffer.concat(unit.packets) });
  }

  /** What was held back for a cut point goes on as it came: the stream changes, or ends. */
  private letGo(out: Piece[]): void {
    this.again(this.cuts.release(), out);
  }

  /** What became of a packet that isn't passed on as it is: the end of a move, if that was decided. */
  private settle(verdict: Exclude<PacketVerdict, "pass">, out: Piece[]): void {
    const { looking, fed } = this;
    if (verdict === "drop" || verdict === "hold" || looking === undefined || fed === undefined) {
      return;
    }
    this.looking = undefined;
    if ("carried" in verdict) {
      this.fed = looking;
      // As for a new run (see `startOver`): what still comes on the PIDs the stream left is no one's.
      this.dropped = this.dropped.union(streamPids(fed)).difference(streamPids(looking));
      this.request.onMove?.({ layout: looking, previous: fed, inPlace: false });
      out.push({ sink: this.sink, bytes: verdict.carried });
    } else {
      this.startOver({ layout: looking, previous: fed, unfit: verdict.why }, verdict.failed, out);
    }
  }

  /**
   * Asks the owner for the sink of what follows a change of layout; with another one, the old one
   * ends here and the new one begins with the stream's tables. `held` is what of the stream was
   * kept back for a move that is off, as it came.
   */
  private startOver(change: Omit<LayoutChange, "delivered">, held: Uint8Array[], out: Piece[]): void {
    const { layout, previous } = change;
    const next = this.request.onLayout({ ...change, delivered: this.delivered });
    this.brake.followed(previous !== undefined);
    this.fed = layout;
    const early = this.early ?? [];
    this.early = undefined;
    if (next !== undefined && next !== this.sink) {
      if (this.delivered) {
        out.push({ sink: this.sink, end: true });
      }
      const left = previous === undefined ? this.dropped : this.dropped.union(streamPids(previous));
      this.dropped = left.difference(streamPids(layout));
      this.sink = next;
      this.delivered = false;
    }
    if (next !== undefined || previous === undefined) {
      // A run that starts here knows the layout from its first bytes, wherever in the stream it is.
      out.push({ sink: this.sink, bytes: this.tables.tablePackets() });
    }
    // Whichever run reads on from here, it reads this layout as it comes: first what was kept back for it.
    this.moves.begin(layout, [...early, ...held]);
    out.push(...early.map((bytes) => ({ sink: this.sink, bytes })));
    if (held.length > 0) {
      out.push({ sink: this.sink, bytes: Buffer.concat(held) });
    }
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
