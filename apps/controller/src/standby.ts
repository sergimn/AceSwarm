import type { PathAssignment, StandbyReaderStatus, StandbySource, StandbyView } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import type { Logger } from "@aceswarm/shared/logger";
import type { EngineSession } from "./acestream.ts";
import { EnginePaths } from "./engine-paths.ts";
import type { EngineHandle } from "./engines.ts";
import { nextRecovery } from "./recovery.ts";
import type { StandbyContext, StandbySettings, StreamStandbysDeps, TakenStandby } from "./standby-deps.ts";
import { StandbyEngine, type StandbyEngineDeps } from "./standby-engine.ts";
import { readerNote, standbyView, waitingViews } from "./standby-view.ts";

export { DEFAULT_STANDBY_SETTINGS } from "./standby-deps.ts";
export type { StandbyContext, StandbySettings, StreamStandbysDeps, TakenStandby } from "./standby-deps.ts";

/** Tries a standby gets (starting its engine, opening its session, warming up) before it goes. */
const STANDBY_MAX_FAILURES = 3;
/**
 * Standbys a path lost one after the other before it gets no new one until its status changes
 * (it goes down, or the stream moves): a path whose probes look fine can still block the stream.
 */
const STANDBY_MAX_PATH_ROUNDS = 3;

/**
 * A stream's hot standbys: on every other network path it may use (or the best `maxPaths` of
 * them), an engine that already pulls the stream, so that a failing stream can move to it within
 * seconds instead of waiting for a new engine to find its peers. Each is an engine of the stream's
 * own, or with engine sharing on, a session on the path's shared engine. The transcoder reads each
 * standby session and throws the data away (`StandbyReaders`), so the engine keeps downloading as
 * if someone watched it, and the time of its last data says whether it is hot.
 *
 * Standbys start, open their sessions and start again in the background, so the supervisor's
 * checks of the stream itself never wait for them, and they go in the background too. Only a few
 * start at once (`startSlots`).
 */
export class StreamStandbys {
  /** The gateway paths of the standbys' own engines, by engine address. */
  readonly gateway: EnginePaths;
  private readonly deps: StreamStandbysDeps;
  private readonly engineDeps: StandbyEngineDeps;
  private readonly logger: Logger;
  private readonly standbys = new Map<string, StandbyEngine>();
  /** Standbys that went and are not removed yet (some wait for their start to end). */
  private readonly leaving = new Set<StandbyEngine>();
  /** Failed standbys per path, when the path may get a new one, and why the last one failed. */
  private readonly pathRetries = new Map<string, { failures: number; retryAt: number; reason: string }>();
  /** Whether standbys were wanted at the last check: hot standby is on and the stream played lately. */
  private wanted = false;
  private readonly running = new Set<Promise<void>>();
  /** The candidates of the last check, best first, to pick the best standby for a failover. */
  private ranking: readonly string[] = [];
  /** The path the stream played on at the last check: a move gives every path a new chance. */
  private lastCurrent: string | null | undefined;
  /** The favourite path of the last check: a new one gets a new chance. */
  private lastFavourite: string | undefined;
  /** Whether the stream may use a path, as of the last check. */
  private usable: ((path: string) => boolean) | undefined;
  /** The transcoder told when each standby last got data, on the last check. */
  private readersSynced = false;
  /**
   * The sources the transcoder was last told to read; unknown at first, so that the first check
   * also stops readers a previous run of the controller left.
   */
  private readerSources: string[] | undefined;

  constructor(deps: StreamStandbysDeps) {
    this.deps = deps;
    this.logger = deps.logger.child({ stream: deps.streamId, component: "standby" });
    this.gateway = new EnginePaths(deps.netgw);
    this.engineDeps = { ...deps, logger: this.logger, gateway: this.gateway };
  }

  get settings(): StandbySettings {
    return this.deps.settings;
  }

  /**
   * One check: drops the standbys the stream no longer needs, has the transcoder read the others,
   * learns which of them are hot, and starts what is missing, in the background.
   */
  async maintain(context: StandbyContext): Promise<void> {
    const wanted = this.dropUnwanted(context);
    if (wanted && context.known) {
      this.usable = context.usable;
      this.dropUnneeded(context);
    }
    await this.syncReaders();
    this.noteHot();
    if (!wanted || !context.known) {
      return;
    }
    this.forgetPathRetries(context);
    for (const standby of this.standbys.values()) {
      if (this.isHot(standby)) {
        standby.failures = 0;
        this.pathRetries.delete(standby.path);
      }
      this.advance(standby, context);
    }
    this.startMissing(context);
  }

  /**
   * Drops every standby when hot standby is off or the stream has not played lately, which every
   * check does, also one of a stream that has no session to play from. Returns whether standbys are
   * wanted at all.
   */
  dropUnwanted(context: Pick<StandbyContext, "enabled" | "active">): boolean {
    if (!context.enabled) {
      this.dropAll("hot standby is off");
    } else if (!context.active) {
      this.dropAll("the stream has not played lately");
    }
    this.wanted = context.enabled && context.active;
    return this.wanted;
  }

  /**
   * Learns when each standby last brought data, without changing what the transcoder reads. For
   * the time a step takes long and no check runs: a standby nobody asks about would count as warming
   * up after `hotWithinMs`, although the transcoder's reader still gets its data.
   */
  async refreshReaders(): Promise<void> {
    if (this.standbys.size === 0) {
      return;
    }
    const sessions = this.bySource(this.openSessions());
    try {
      const readers = await this.deps.transcoder.standbyStatus(this.deps.streamId);
      this.learn(sessions, readers ?? []);
    } catch (error) {
      this.logger.debug({ err: describeError(error) }, "could not reach the transcoder for the standbys");
    }
    this.noteHot();
  }

  /**
   * Whether a standby is ready for a failover to a path that `eligible` accepts: hot, and with data
   * from `freshAfter` on, so that it still gets data now that the stream doesn't (see `hot`).
   */
  hasHot(eligible: (path: string) => boolean, freshAfter: number): boolean {
    return this.hot(eligible, freshAfter) !== undefined;
  }

  /** The best standby `hasHot` accepts, taken out for a failover. */
  takeHot(eligible: (path: string) => boolean, freshAfter: number): TakenStandby | undefined {
    return this.take(this.hot(eligible, freshAfter));
  }

  /**
   * The standby on `path`, taken out for a move there, once it is stable (see
   * `StandbyEngine.isStable`) and the transcoder answered on this check. One a move to it failed on
   * waits like after a failed failover, and has to be stable again from then on.
   */
  takeStable(path: string): TakenStandby | undefined {
    const { settings } = this.deps;
    const stable = (standby: StandbyEngine): boolean => standby.path === path && standby.isStable(settings);
    return this.readersSynced ? this.take(this.ready().find((standby) => stable(standby))) : undefined;
  }

  /** The standby on `path` once its session is open, hot or not, taken out for a move there. */
  takeOn(path: string): TakenStandby | undefined {
    return this.take(this.ready().find((standby) => standby.path === path));
  }

  /**
   * The standby whose session the transcoder plays from: a failover to it gave up waiting, and its
   * video arrived later. Taken out, for the stream to finish that failover.
   */
  takeBySource(source: string): TakenStandby | undefined {
    return this.take(
      this.standbys.values().find((standby) => !standby.busy && standby.session?.playbackUrl === source),
    );
  }

  /**
   * A failover to the standby failed: it goes back, and no failover tries it again for a while.
   * The transcoder stopped reading it, so the next check has it read again, and it has to bring
   * data from then on to count as hot.
   */
  restore(taken: TakenStandby): void {
    const { standby } = taken;
    standby.failedFailovers += 1;
    standby.blockedUntil = this.retryAfter(standby.failedFailovers);
    standby.lastDataAt = undefined;
    standby.hotSince = undefined;
    standby.openedAt = this.deps.now();
    if (this.standbys.has(standby.path)) {
      // Another standby took the path meanwhile: this one goes.
      standby.dropped = true;
      void this.track(this.remove(standby, "the path has another standby"));
      return;
    }
    this.standbys.set(standby.path, standby);
  }

  /** The stream now plays from the taken standby's engine: the stream's own list takes its address. */
  promoted(taken: TakenStandby): void {
    taken.standby.promoted();
  }

  /**
   * The engine of its own the stream played from before it failed over, which becomes the standby
   * on its path. Its address has its path at the gateway already. A path that has a standby keeps
   * that one, and this engine goes. It opens a session on the next check.
   */
  async adopt(path: string, engine: EngineHandle): Promise<void> {
    const standby = StandbyEngine.adopted(path, engine, this.engineDeps);
    if (this.standbys.has(path) || this.usable?.(path) === false) {
      standby.dropped = true;
      const why = this.standbys.has(path) ? "the path has a standby already" : "the stream may not use its path";
      await this.remove(standby, why);
      return;
    }
    this.logger.info({ path, engine: engine.name }, "keeping the engine the stream left as the standby on its path");
    this.standbys.set(path, standby);
  }

  /** Whether the engine is one of the standbys', or one a standby is starting. */
  owns(engine: EngineHandle): boolean {
    return [...this.standbys.values(), ...this.leaving].some((standby) => standby.owns(engine));
  }

  /** The gateway paths of the standbys' own engines (re-sent periodically). */
  assignments(): PathAssignment[] {
    return this.gateway.list();
  }

  /**
   * The standbys, and the paths that lost theirs and wait for a new one (or were given up), which
   * stay as failed ones without an engine, so that the stream's figure doesn't read as if there
   * were nothing to wait for.
   */
  view(): StandbyView[] {
    const { hotWithinMs } = this.deps.settings;
    const own = this.standbys.values().map((standby) => standbyView(standby, hotWithinMs));
    // Within `STANDBY_MAX_PATHS`: a path beyond it isn't waiting for anything.
    const room = this.limit() - this.standbys.size;
    const waiting = this.wanted
      ? waitingViews(this.pathRetries, this.ranking, (path) => this.standbys.has(path), room)
      : [];
    return [...own, ...waiting].toSorted((a, b) => a.path.localeCompare(b.path, "en"));
  }

  /**
   * Removes the standbys with engines of their own, for a stream that starts sharing engines, and
   * waits until they are gone.
   */
  async dropOwn(why: string): Promise<void> {
    for (const standby of this.standbys.values()) {
      if (!standby.shared) {
        this.drop(standby, why);
      }
    }
    await this.settle();
  }

  /** Removes every standby, in the background. */
  dropAll(why: string): void {
    for (const standby of this.standbys.values()) {
      this.drop(standby, why);
    }
  }

  /** Removes every standby and stops the transcoder's readers: the stream stops. */
  async teardown(): Promise<void> {
    this.dropAll("the stream stopped");
    await this.settle();
    await this.syncReaders();
  }

  /** Waits until no standby work runs in the background (for teardown and tests). */
  async settle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled(this.running);
    }
  }

  // ---- checks ---------------------------------------------------------------------------------

  private dropUnneeded(context: StandbyContext): void {
    // Standbys keep their paths over better ones: moving a standby starts it again from no peers.
    const kept = this.standbys
      .values()
      .filter((standby) => context.candidates.includes(standby.path))
      .toArray()
      .toSorted((a, b) => context.candidates.indexOf(a.path) - context.candidates.indexOf(b.path));
    // The favourite path gets its standby even when the others fill the limit: the last of them goes.
    const room = this.limit() - (this.favouriteMissing(context) ? 1 : 0);
    const extra = new Set(kept.slice(Math.max(room, 0)).map((standby) => standby.path));
    for (const standby of this.standbys.values()) {
      const why = this.dropReason(standby, context, extra);
      if (why !== undefined) {
        this.drop(standby, why);
      }
    }
    this.ranking = context.candidates;
  }

  private dropReason(standby: StandbyEngine, context: StandbyContext, extra: ReadonlySet<string>): string | undefined {
    if (!context.usable(standby.path)) {
      return "the stream may not use its path";
    }
    if (standby.path === context.current) {
      return "the stream plays on its path now";
    }
    if (standby.shared !== context.sharing) {
      return context.sharing ? "streams share engines now" : "streams have engines of their own now";
    }
    if (standby.shared && standby.engine !== undefined && this.deps.shared?.isCurrent(standby.engine) !== true) {
      return "its shared engine was replaced";
    }
    if (!context.up(standby.path)) {
      const now = this.deps.now();
      standby.downSince ??= now;
      return now - standby.downSince >= this.deps.settings.downGraceMs ? "its path is down" : undefined;
    }
    standby.downSince = undefined;
    return extra.has(standby.path) ? "more standbys than STANDBY_MAX_PATHS" : undefined;
  }

  /**
   * The favourite path has no standby and would get one now (see `startMissing`). Not while it waits
   * for its next try, or was given up: the others' standbys would go for nothing.
   */
  private favouriteMissing(context: StandbyContext): boolean {
    const { favourite } = context;
    return (
      favourite !== undefined &&
      !this.standbys.has(favourite) &&
      favourite !== context.sparePath &&
      this.deps.now() >= (this.pathRetries.get(favourite)?.retryAt ?? 0)
    );
  }

  /**
   * Starts the next step of a standby that isn't ready yet, or starts it again if it brings no data.
   * Nothing happens on a path that is down. Starting an engine, or starting one again, waits for a
   * start slot.
   */
  private advance(standby: StandbyEngine, context: StandbyContext): void {
    const now = this.deps.now();
    if (this.waits(standby, context, now)) {
      return;
    }
    if (standby.session === undefined && standby.engine !== undefined) {
      this.run(standby, "could not open a session", () => standby.open(context.openSession));
      return;
    }
    const quietMs = now - (standby.lastDataAt ?? standby.openedAt ?? now);
    const startsEngine = standby.engine === undefined || !standby.shared;
    if (standby.engine !== undefined && (this.isHot(standby) || quietMs < this.deps.settings.warmupMs)) {
      return;
    }
    const slot = startsEngine ? this.takeSlot() : undefined;
    if (slot === false) {
      // Other standbys start first.
      return;
    }
    if (standby.engine === undefined) {
      this.run(standby, "could not start its engine or session", () => standby.start(context.openSession), slot);
      return;
    }
    // Without data for too long, it starts again, unless that was its last try.
    // What the reader reports is the reason it brings no data, so that is what the UI says.
    const quiet = `no data for ${String(Math.round(quietMs / 1000))}s`;
    const note = standby.readerNote;
    if (this.fail(standby, note === undefined ? quiet : `${quiet}: ${note}`, note ?? quiet)) {
      slot?.();
      return;
    }
    this.run(standby, "could not start again", () => standby.startAgain(context.openSession), slot);
  }

  /**
   * Nothing to do for the standby now: it is busy or went, waits for its next try, its path is down,
   * or the transcoder reads its session itself (so its reader brings no data).
   */
  private waits(standby: StandbyEngine, context: StandbyContext, now: number): boolean {
    const url = standby.session?.playbackUrl;
    const taken = url !== undefined && context.transcoderSources.includes(url);
    return standby.busy || standby.dropped || taken || now < standby.retryAt || !context.up(standby.path);
  }

  /** A new standby on the best path that has none, one per check, while a start slot is free. */
  private startMissing(context: StandbyContext): void {
    if (this.standbys.size >= this.limit()) {
      return;
    }
    const now = this.deps.now();
    const path = context.candidates.find(
      (candidate) =>
        !this.standbys.has(candidate) &&
        candidate !== context.sparePath &&
        now >= (this.pathRetries.get(candidate)?.retryAt ?? 0),
    );
    const slot = path === undefined ? false : this.takeSlot();
    if (path === undefined || slot === false) {
      return;
    }
    const standby = new StandbyEngine(path, context.sharing, this.engineDeps);
    this.standbys.set(path, standby);
    this.logger.info({ path, shared: standby.shared }, "starting a standby");
    this.run(standby, "could not start its engine or session", () => standby.start(context.openSession), slot);
  }

  /** A start slot (see `startSlots`): its release, undefined without a limit, false while all are taken. */
  private takeSlot(): (() => void) | undefined | false {
    const slots = this.deps.startSlots;
    if (slots === undefined) {
      return undefined;
    }
    return slots.tryTake()
      ? () => {
          slots.release();
        }
      : false;
  }

  /**
   * A path that went down, or a stream that moved, gives every path a new chance. So does making a
   * path the favourite, for that path.
   */
  private forgetPathRetries(context: StandbyContext): void {
    if (context.favourite !== this.lastFavourite) {
      this.lastFavourite = context.favourite;
      if (context.favourite !== undefined) {
        this.pathRetries.delete(context.favourite);
      }
    }
    if (context.current !== this.lastCurrent) {
      this.lastCurrent = context.current;
      this.pathRetries.clear();
      return;
    }
    for (const path of this.pathRetries.keys()) {
      if (!context.up(path)) {
        this.pathRetries.delete(path);
      }
    }
  }

  private limit(): number {
    return this.deps.settings.maxPaths === 0 ? Infinity : this.deps.settings.maxPaths;
  }

  // ---- background work ------------------------------------------------------------------------

  /**
   * Runs `work` in the background. When it throws, the error is logged, and the stream's view gives
   * `couldNot` instead: an error starts with the address of a request, which says nothing to the UI.
   */
  private run(standby: StandbyEngine, couldNot: string, work: () => Promise<void>, done?: () => void): void {
    standby.busy = true;
    const task = (async () => {
      try {
        await work();
      } catch (error) {
        if (!standby.dropped) {
          this.fail(standby, describeError(error), couldNot);
        }
      } finally {
        standby.busy = false;
        done?.();
      }
      if (!standby.dropped) {
        return;
      }
      await this.remove(standby, "it went while starting");
    })();
    void this.track(task);
  }

  private async track(task: Promise<void>): Promise<void> {
    this.running.add(task);
    try {
      await task;
    } catch (error) {
      this.logger.warn({ err: error }, "standby work failed");
    } finally {
      this.running.delete(task);
    }
  }

  /**
   * A try failed: waits before the next one, and after the last one, the standby goes (returns
   * true). `why` is logged, and `shown` (by default the same) is the reason the stream's view gives.
   */
  private fail(standby: StandbyEngine, why: string, shown = why): boolean {
    standby.failures += 1;
    standby.failure = shown;
    standby.retryAt = this.retryAfter(standby.failures);
    const last = standby.failures >= STANDBY_MAX_FAILURES;
    this.logger.warn(
      { path: standby.path, failures: standby.failures, reason: why },
      last ? "standby failed; removing it" : "standby failed; trying again",
    );
    if (!last) {
      return false;
    }
    // The path gets a new standby later, after a longer wait each time, and none after a few rounds.
    const failures = (this.pathRetries.get(standby.path)?.failures ?? 0) + STANDBY_MAX_FAILURES;
    const done = failures >= STANDBY_MAX_FAILURES * STANDBY_MAX_PATH_ROUNDS;
    this.pathRetries.set(standby.path, {
      failures,
      retryAt: done ? Infinity : this.retryAfter(failures),
      reason: shown,
    });
    if (done) {
      this.logger.warn({ path: standby.path }, "no new standby on the path until it goes down or the stream moves");
    }
    this.drop(standby, why);
    return true;
  }

  private retryAfter(failures: number): number {
    const now = this.deps.now();
    return nextRecovery({ failures, lastActionAt: now }, this.deps.settings.policy, false).notBefore;
  }

  /**
   * Takes the standby out. Its engine (or its place on a shared engine) goes in the background, once
   * nothing runs on it: removing a container can take seconds, and the stream's checks don't wait.
   */
  private drop(standby: StandbyEngine, why: string): void {
    if (this.standbys.get(standby.path) === standby) {
      this.standbys.delete(standby.path);
    }
    if (standby.dropped) {
      return;
    }
    standby.dropped = true;
    if (standby.busy) {
      this.leaving.add(standby);
      this.logger.info({ path: standby.path, reason: why }, "removing the standby once it finished starting");
      return;
    }
    void this.track(this.remove(standby, why));
  }

  /** Removes a standby that went; `owns` still knows its engine until it is gone. */
  private async remove(standby: StandbyEngine, why: string): Promise<void> {
    this.leaving.add(standby);
    try {
      await standby.dispose(why);
    } finally {
      this.leaving.delete(standby);
    }
  }

  // ---- transcoder -----------------------------------------------------------------------------

  /** Has the transcoder read every open standby session, and learns when each one last brought data. */
  private async syncReaders(): Promise<void> {
    const open = this.openSessions();
    const sessions = this.bySource(open);
    // With its stat URL, only data that comes while its live edge moves counts.
    const stats: StandbySource[] = open.map(({ session }) => ({ source: session.playbackUrl, stat: session.statUrl }));
    const sources = sessions.keys().toArray();
    this.readersSynced = false;
    if (sources.length === 0 && this.readerSources?.length === 0) {
      return;
    }
    let status: StandbyReaderStatus[] | undefined;
    try {
      status = await this.deps.transcoder.setStandbys(this.deps.streamId, stats);
    } catch (error) {
      this.logger.debug({ err: describeError(error) }, "could not reach the transcoder for the standbys");
      return;
    }
    this.readersSynced = status !== undefined;
    // Without a pipeline the transcoder reads nothing for the stream.
    this.readerSources = status === undefined ? [] : sources;
    this.learn(sessions, status ?? []);
  }

  /** The standbys whose session is open and which are not busy starting or restarting it. */
  private openSessions(): { standby: StandbyEngine; session: EngineSession }[] {
    return this.standbys
      .values()
      .flatMap((standby) =>
        standby.busy || standby.session === undefined ? [] : [{ standby, session: standby.session }],
      )
      .toArray();
  }

  private bySource(open: readonly { standby: StandbyEngine; session: EngineSession }[]): Map<string, StandbyEngine> {
    return new Map(open.map(({ standby, session }) => [session.playbackUrl, standby]));
  }

  /** Notes when each standby's reader last got data, and what it says is wrong with the session. */
  private learn(sessions: ReadonlyMap<string, StandbyEngine>, readers: readonly StandbyReaderStatus[]): void {
    for (const reader of readers) {
      const standby = sessions.get(reader.source);
      if (standby !== undefined) {
        standby.readerNote = readerNote(reader);
      }
      const at = reader.lastDataAt === null ? undefined : Date.parse(reader.lastDataAt);
      // Data from before its session opened, or before a failed failover, doesn't count. Nor does
      // data older than what a check already learned while this answer was on its way.
      if (
        standby !== undefined &&
        at !== undefined &&
        at >= (standby.openedAt ?? 0) &&
        at >= (standby.lastDataAt ?? 0)
      ) {
        standby.lastDataAt = at;
        standby.played = true;
      }
    }
  }

  // ---- helpers --------------------------------------------------------------------------------

  /** Notes since when each standby is hot without a break, as of this check. */
  private noteHot(): void {
    for (const standby of this.standbys.values()) {
      standby.noteHot(this.deps.settings.hotWithinMs);
    }
  }

  private isHot(standby: StandbyEngine): boolean {
    return standby.isHot(this.deps.settings.hotWithinMs);
  }

  /**
   * The best standby for a failover. Its data must come from this check, and from `freshAfter` on:
   * when the transcoder can't be reached, or the broadcast pauses on every path, the standbys' last
   * data is as old as the stream's last video, and moving would not help.
   */
  private hot(eligible: (path: string) => boolean, freshAfter: number): StandbyEngine | undefined {
    if (!this.readersSynced) {
      return undefined;
    }
    return this.ready().find(
      (standby) => this.isHot(standby) && (standby.lastDataAt ?? 0) >= freshAfter && eligible(standby.path),
    );
  }

  /** Standbys a failover can take, best path first. */
  private ready(): StandbyEngine[] {
    const now = this.deps.now();
    return this.standbys
      .values()
      .filter(
        (standby) =>
          !standby.busy &&
          !standby.dropped &&
          standby.engine !== undefined &&
          standby.session !== undefined &&
          now >= standby.blockedUntil,
      )
      .toArray()
      .toSorted((a, b) => this.rank(a.path) - this.rank(b.path));
  }

  private rank(path: string): number {
    const index = this.ranking.indexOf(path);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  private take(standby: StandbyEngine | undefined): TakenStandby | undefined {
    if (standby?.engine === undefined || standby.session === undefined) {
      return undefined;
    }
    this.standbys.delete(standby.path);
    // The stream moves to its path: a failed round there no longer says anything.
    this.pathRetries.delete(standby.path);
    return { path: standby.path, engine: standby.engine, session: standby.session, hot: this.isHot(standby), standby };
  }
}
