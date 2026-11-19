import type { LiveEdgeView, StreamState } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import type { RecoveryPolicy, RecoveryState } from "./recovery.ts";

/**
 * A stream's wait for its broadcast while that sends nothing new: the transcoder found the live
 * edge of its source stale (see `evaluateHealth`), stopped reading it and publishes none of it.
 * Restarting things can't bring video back then, only the broadcast coming back can. So until a
 * session's live edge moves again, the recovery ladder waits longer between its steps, its steps
 * and tries show as waiting for the source rather than as recoveries or starts, the shared engine
 * is not blamed, and the stream's standbys go (they would only load the same old window).
 */
export class SourceWait {
  private stale = false;
  /** The newest live edge seen while it waits, by the broadcaster's clock. */
  private edgeAt: number | undefined;
  /** It may try once before the next step is due, when the live edge moves (see `moved`). */
  private early = true;
  /** Where the stream's recovery ladder was when the wait began (see `back`). */
  private ladder: RecoveryState | undefined;
  private readonly policy: RecoveryPolicy;
  private readonly logger: Logger;

  /**
   * `retryMs`: the first wait between steps (30 s by default). It doubles up to the usual maximum,
   * and never gets shorter than `retryMs`.
   */
  constructor(logger: Logger, usual: RecoveryPolicy, retryMs = 30_000) {
    this.logger = logger;
    const baseDelayMs = Math.max(retryMs, usual.baseDelayMs);
    this.policy = { baseDelayMs, maxDelayMs: Math.max(baseDelayMs, usual.maxDelayMs) };
  }

  get waiting(): boolean {
    return this.stale;
  }

  /** The source is stale: the stream waits for its broadcast from now on. `ladder`: its recovery ladder now. */
  begin(reason: string, liveEdge: LiveEdgeView | null | undefined, ladder?: RecoveryState): void {
    if (!this.stale) {
      this.logger.warn({ reason, liveEdge }, "the broadcast sends no new data; waiting for it");
      this.edgeAt = edgeTime(liveEdge);
      this.ladder = ladder;
    }
    this.stale = true;
  }

  /** New video came: the wait is over. */
  end(): void {
    this.stale = false;
    this.edgeAt = undefined;
    this.ladder = undefined;
    this.early = true;
  }

  /**
   * The broadcast sends new data again, though the session brings no video: its engine serves the
   * broadcast too far behind its live edge (`LiveEdgeView.staleBecause` is "behind"). The wait is
   * over, and what is left is the engine's to fix.
   *
   * Returns the recovery ladder to go on from, when it was waiting and knows one: the ladder as
   * it was when the wait began. The wait's tries were for a broadcast that sent nothing, so they
   * don't count against the engines. The ladder must not start over here: engines that are
   * replaced as soon as they show how far behind they serve never see the broadcast move, so
   * after a while of them the transcoder can't tell that the broadcast goes on, and a short wait
   * begins and ends on the next engine. Starting over each time would keep the waits between
   * lagging engines from growing.
   */
  back(liveEdge: LiveEdgeView | null | undefined): RecoveryState | undefined {
    if (!this.stale) {
      return undefined;
    }
    const { ladder } = this;
    this.logger.info({ liveEdge }, "the broadcast sends new data again, but the engine serves it too far behind");
    this.end();
    return ladder;
  }

  /** A restart by hand: the ladder starts over from it, and the next step may come early again. */
  byHand(): void {
    this.ladder = undefined;
    this.due();
  }

  /**
   * Whether to try now rather than when the next step is due: the live edge of the session it
   * waits on moved again (the engine may notice the broadcast is back before the next try). At
   * most once between two steps that came when due (see `due`), so an edge that moves while the
   * session stays unusable can't make it try on every check.
   */
  moved(liveEdge: LiveEdgeView | null | undefined): boolean {
    const edgeAt = edgeTime(liveEdge);
    if (!this.stale || edgeAt === undefined) {
      return false;
    }
    const seen = this.edgeAt;
    this.edgeAt = Math.max(seen ?? edgeAt, edgeAt);
    if (!this.early || seen === undefined || edgeAt <= seen || liveEdge?.state === "stale") {
      return false;
    }
    this.early = false;
    this.logger.info({ liveEdge }, "the live edge moved while waiting for the broadcast; trying now");
    return true;
  }

  /** A step came when it was due: the next one may come early again. */
  due(): void {
    this.early = true;
  }

  /**
   * How long until the ladder's next step, due at `notBefore`: none when the live edge it waits
   * on moved (see `moved`).
   */
  until(notBefore: number, now: number, liveEdge: LiveEdgeView | null | undefined): number {
    if (this.moved(liveEdge)) {
      return 0;
    }
    const wait = notBefore - now;
    if (wait <= 0) {
      this.due();
    }
    return wait;
  }

  /** What the stream does once the wait is over. */
  get next(): string {
    return this.stale ? "trying a new engine" : "retrying";
  }

  /** The waits between the ladder's steps. */
  waits(usual: RecoveryPolicy): RecoveryPolicy {
    return this.stale ? this.policy : usual;
  }

  /** The state to show for `state`: while it waits, every state is waiting for the source. */
  state(state: StreamState): StreamState {
    return this.stale ? "stale-source" : state;
  }

  /** A try that has not brought video yet: one while it waits only counts once its live edge moves. */
  starting(message: string): string {
    return this.stale ? `waiting for the broadcast; ${message}` : message;
  }
}

function edgeTime(liveEdge: LiveEdgeView | null | undefined): number | undefined {
  return liveEdge?.edgeAt === null || liveEdge?.edgeAt === undefined ? undefined : Date.parse(liveEdge.edgeAt);
}
