import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import { buildFfmpegArgs, type FfmpegPlan } from "./ffmpeg-args.ts";
import { attachFfmpeg } from "./ffmpeg-process.ts";
import { Generation, modifiedAt, statusWithoutRun, VARIANTS, type GenerationPlan, type Variant } from "./generation.ts";
import { KeyFrames, REOPENS_AFTER_FALLBACK, type Decoding } from "./key-frames.ts";
import {
  DEFAULT_LIVE_EDGE_SETTINGS,
  LiveEdge,
  newerSeed,
  watchLiveEdge as defaultWatch,
  type LiveEdgeSeed,
  type LiveEdgeSettings,
  type WatchLiveEdge,
} from "./live-edge.ts";
import type { PipelineEvents, PipelineOptions, PipelineSettings, Spawner } from "./pipeline-settings.ts";
import { parseMediaPlaylist, segmentIndex, VirtualPlaylist, type PlaylistSegment } from "./playlist.ts";
import { makeRunDirectory, makeRunDirectoryNow, removeStreamFiles } from "./run-files.ts";
import { SourceFeeds, type Succession } from "./source-feeds.ts";
import { readSource } from "./source-reader.ts";
import { DEFAULT_STUCK_LIMITS, StuckRuns } from "./stuck-runs.ts";
import { describeLayout, videoCodecOfLayout } from "./ts-tables.ts";

export { VARIANTS, type Variant } from "./generation.ts";
export type { PipelineEvents, PipelineOptions, PipelineSettings, PlanSettings, Spawner } from "./pipeline-settings.ts";

/** ffmpeg gets the stream on its standard input, from the source's reader. */
const defaultSpawner: Spawner = (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

const OLD_GENERATION_TTL_MS = 60_000;
/** How long after a run that failed before any video its source is opened again (see `start`). */
const REOPEN_DELAY_MS = 1000;

/**
 * The ffmpeg work of one stream. A new source starts a new generation in its own directory;
 * players see a single continuous playlist because {@link VirtualPlaylist} stitches generations.
 * With handover, the new generation runs next to the old one and only takes over once it has
 * produced its first segment (make-before-break).
 *
 * The pipeline reads each source itself and passes it on to ffmpeg (see `SourceFeeds`). When the
 * broadcast changes its layout mid-stream, a new generation takes over right at the change, on the
 * same connection to the engine (see `succeed`).
 *
 * With a source's stat URL, its output is only published while the engine's live edge moves (see
 * `LiveEdge`): an engine whose broadcast stopped keeps serving the old window it has, and so do
 * its peers. A new source's segments wait until its edge is seen to move; a source whose edge
 * stops gets its ffmpeg stopped, and its segments leave the playlist once they are old.
 */
export class Pipeline {
  readonly id: string;
  private readonly settings: PipelineSettings;
  private readonly logger: Logger;
  private readonly events: PipelineEvents;
  private readonly spawner: Spawner;
  private readonly now: () => number;
  private readonly watchLiveEdge: WatchLiveEdge;
  private readonly liveEdge: LiveEdgeSettings;
  private readonly root: string;
  private readonly playlists: Record<Variant, VirtualPlaylist>;
  private active: Generation | undefined;
  private pending: Generation | undefined;
  /** Runs that were retired and whose files are still to be removed (see `retire`). */
  private readonly retiredRuns = new Set<Generation>();
  private nextNumber = 1;
  /** Reads the sources, and knows what the full output does with their video. */
  private readonly feeds: SourceFeeds;
  /** When the source players get last changed its layout mid-stream (see `succeed`, and `FeedHost.moved`). */
  private layoutChangedAt: number | undefined;
  /** Whether the stream's broadcast has key frames ffmpeg can use (see `KeyFrames`). */
  private readonly keyFrames = new KeyFrames();
  private readonly stuck: StuckRuns;
  /** When it last started ffmpeg again by itself, as its run was stuck (see `PipelineStatus.restartedAt`). */
  private restartedAt: number | undefined;
  /**
   * The newest thumbnail players may see, and when it was written as far as this pipeline knows:
   * a source's ffmpeg can still write one as it stops, which must not make an old picture new.
   */
  private lastThumbnail: { path: string; at: number } | undefined;
  /** The newest live edge of a generation that is gone: the next one starts from it. */
  private lastEdge: LiveEdgeSeed | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    id: string,
    settings: PipelineSettings,
    logger: Logger,
    events: PipelineEvents,
    options: PipelineOptions = {},
  ) {
    this.id = id;
    this.settings = settings;
    this.logger = logger.child({ stream: id });
    this.events = events;
    this.spawner = options.spawner ?? defaultSpawner;
    this.now = options.now ?? Date.now;
    this.watchLiveEdge = options.watchLiveEdge ?? defaultWatch;
    this.liveEdge = settings.liveEdge ?? DEFAULT_LIVE_EDGE_SETTINGS;
    const host = {
      succeed: (old: Generation, how: Succession, reason: string) => this.succeed(old, how, reason),
      publish: (run: Generation) => this.publish(run, () => this.feeds.drains(run)),
      retire: (run: Generation) => {
        this.retire(run);
      },
      moved: (run: Generation) => {
        // As for a new run (see `succeed`): only for the source players get, and one that had video
        // since its last move. Moves that keep coming over a run that shows nothing must not look
        // like a stream that does.
        const shown = run === this.active && run.frames > run.framesAtMove;
        this.layoutChangedAt = shown ? this.now() : this.layoutChangedAt;
        run.framesAtMove = run.frames;
      },
      keyFramesBack: () => {
        this.keyFrames.allFrames = false;
      },
    };
    const stuck = settings.stuck ?? DEFAULT_STUCK_LIMITS;
    const openSource = options.openSource ?? readSource;
    this.feeds = new SourceFeeds(host, openSource, this.logger, this.now, stuck.fullOutputStallMs);
    this.stuck = new StuckRuns(stuck, settings.plan.thumbnailIntervalSeconds, options);
    this.root = join(settings.hlsDir, id);
    this.playlists = {
      full: new VirtualPlaylist(settings.plan.playlistSize),
      preview: new VirtualPlaylist(settings.plan.playlistSize),
    };
    this.syncTimer = setInterval(() => {
      void this.sync();
    }, 1000);
  }

  /**
   * Points the pipeline at a (new) source. With `handover`, the input timeout (how long the
   * source's reader waits for data, at any time of the run) is at least the handover timeout, even
   * when there is no picture left to keep: a new engine on a slow swarm can take longer than the
   * usual input timeout to deliver its first data, and the controller waits the whole handover
   * for it.
   *
   * With `reopens`, the source is opened again up to that many times, each time by a new ffmpeg
   * run, when a run fails before any video: an engine that has just lost another reader of the
   * session may refuse a new one for a moment (it allows one reader per session).
   *
   * With `stat`, the session's stat URL, its output is only published while its live edge moves.
   */
  async start(source: string, handover: boolean, reopens = 0, stat?: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    const inputTimeoutSeconds = handover ? this.handoverInputTimeoutSeconds() : this.settings.plan.inputTimeoutSeconds;
    const canHandOver = handover && this.active !== undefined && this.active.state !== "exited";
    if (this.pending !== undefined) {
      this.retire(this.pending);
      this.pending = undefined;
    }
    if (canHandOver) {
      const launched = await this.launch(source, "handover", inputTimeoutSeconds, reopens, stat);
      this.replace("pending", launched);
      return;
    }
    const previous = this.active;
    const reason = previous === undefined ? "start" : "restart";
    const launched = await this.launch(source, reason, inputTimeoutSeconds, reopens, stat);
    if (previous !== undefined) {
      this.retire(previous);
    }
    // Players get this source from here on: what the last one's layout did is not about it.
    this.layoutChangedAt = undefined;
    this.replace("active", launched);
  }

  /**
   * Puts a generation that `start` launched in its place, retiring the one there: a sync may have
   * opened the old source again meanwhile (see `reopen`).
   */
  private replace(slot: "active" | "pending", generation: Generation): void {
    const displaced = this[slot];
    this[slot] = generation;
    if (displaced !== undefined && displaced !== generation) {
      this.retire(displaced);
    }
  }

  status(): PipelineStatus {
    const generation = this.active;
    const pendingSource = this.pending?.source ?? null;
    const layoutChangedAt = this.layoutChangedAt === undefined ? null : new Date(this.layoutChangedAt).toISOString();
    const restartedAt = this.restartedAt === undefined ? null : new Date(this.restartedAt).toISOString();
    if (generation === undefined) {
      return statusWithoutRun(this.id, this.now(), { layoutChangedAt, pendingSource, restartedAt });
    }
    const { layout } = generation;
    const tableCodec = layout === undefined ? undefined : videoCodecOfLayout(layout);
    return {
      id: this.id,
      // A run that failed before any video, and whose source is opened again, is still starting.
      state: generation.willReopen() ? "starting" : generation.state,
      source: generation.source,
      startedAt: new Date(generation.startedAt).toISOString(),
      // Only video players could get: none while a new source's live edge hasn't moved yet.
      lastFrameAt:
        generation.publishedFrameAt === undefined ? null : new Date(generation.publishedFrameAt).toISOString(),
      frames: generation.frames,
      fps: generation.frameRate(),
      videoCodec: generation.videoCodec ?? tableCodec ?? null,
      mode: generation.mode,
      layout: layout === undefined ? null : describeLayout(layout),
      layoutChangedAt,
      exitCode: generation.exitCode,
      error: generation.error,
      pendingSource,
      liveEdge: generation.watch?.edge.view() ?? null,
      restartedAt,
    };
  }

  /** How the stream's current ffmpeg run decodes the broadcast; undefined before its first run. */
  readonly decoding = (): Decoding | undefined => this.active && this.keyFrames.decoding(this.planOf(this.active));

  async playlist(variant: Variant): Promise<string | undefined> {
    await this.sync();
    return this.playlists[variant].render();
  }

  /**
   * The newest thumbnail players may see: one the active source wrote since its output is
   * published, or else the previous one while it is recent (see `PipelineSettings.liveEdge`).
   */
  thumbnailPath(): string | undefined {
    const active = this.active;
    const candidate = active === undefined ? undefined : join(active.directory, "thumbnail.jpg");
    const since = active?.publishing() === true ? active.publishingSince : undefined;
    const written = candidate === undefined ? undefined : modifiedAt(candidate);
    if (candidate !== undefined && since !== undefined && written !== undefined && written >= since) {
      this.lastThumbnail = { path: candidate, at: written };
    }
    const last = this.lastThumbnail;
    const recent = last !== undefined && this.now() - last.at <= this.liveEdge.staleAfterMs;
    return recent && existsSync(last.path) ? last.path : undefined;
  }

  /** Resolves a segment request to a file path, rejecting anything outside the pipeline. */
  segmentPath(generation: string, variant: string, file: string): string | undefined {
    if (!/^g\d{1,6}$/.test(generation) || !VARIANTS.includes(variant as Variant) || !/^seg_\d{1,9}\.ts$/.test(file)) {
      return undefined;
    }
    const path = join(this.root, generation, variant, file);
    return existsSync(path) ? path : undefined;
  }

  /**
   * Stops the stream's ffmpeg runs and removes all their files. ffmpeg is killed at once: let it
   * stop by itself and it writes out what it holds first, a whole segment or a stalled full
   * output's backlog, into a directory that is going. That goes for the runs that were retired
   * moments ago and still stop, and for the ones that still write out what they had when a
   * layout change ended their input (see `SourceFeeds.drain`). The stop does not fail over files
   * that could not be removed (see `removeStreamFiles`).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.syncTimer !== undefined) {
      clearInterval(this.syncTimer);
    }
    for (const generation of [this.active, this.pending, ...this.retiredRuns]) {
      generation?.stopNow();
    }
    this.feeds.stop();
    this.active = undefined;
    this.pending = undefined;
    await removeStreamFiles(this.root, this.logger);
  }

  /** Copies new segments into the virtual playlists and completes pending handovers. */
  async sync(): Promise<void> {
    await this.syncPending();
    this.expireOldSegments();
    const draining = await this.feeds.drain();
    const active = this.active;
    if (active === undefined) {
      return;
    }
    this.stopIfStale(active);
    if (this.restartIfStuck(active)) {
      return;
    }
    if (this.mayReopenNow(active)) {
      this.reopen(active);
      return;
    }
    // What a run that handed over still writes out comes first (see `SourceFeeds.drain`).
    if (this.fallBackToAllFrames(active) || draining || !(await this.openGate(active))) {
      return;
    }
    await this.publish(active, () => active === this.active);
  }

  /** Adds the segments the generation may publish to the playlists, while it is `still` the one to. */
  private async publish(generation: Generation, still: () => boolean): Promise<void> {
    for (const variant of VARIANTS) {
      const segments = await this.publishableSegments(generation, variant);
      if (segments.length > 0 && still()) {
        const prefix = `../g${String(generation.number)}/${variant}/`;
        const added = this.playlists[variant].append(generation.number, segments, prefix, this.now());
        if (variant === "full" && added > 0 && !generation.published) {
          // Its video counts from now on: players can get it. A run that has no frame of its own
          // yet leaves the last one it carries, if any (see `swap`, and `Generation.takeOver`):
          // a segment alone is no video, it may hold nothing but sound.
          generation.published = true;
          generation.publishedFrameAt = generation.lastFrameAt ?? generation.publishedFrameAt;
        }
      }
    }
  }

  /**
   * Whether the generation's output may be published. The first time it may, it notes the last
   * segment of each variant written until then: those came before its live edge was seen to move.
   */
  private async openGate(generation: Generation): Promise<boolean> {
    if (!generation.publishing()) {
      return false;
    }
    if (generation.publishingSince === undefined) {
      generation.publishingSince = this.now();
      for (const variant of VARIANTS) {
        const written = generation.watch === undefined ? [] : await this.segmentsOf(generation, variant);
        generation.publishFrom[variant] = Math.max(-1, ...written.map((segment) => segmentIndex(segment.uri)));
      }
      if (generation.watch !== undefined) {
        this.logger.info(
          { generation: generation.number, liveEdge: generation.watch.edge.view() },
          "live edge moves; publishing",
        );
      }
    }
    return true;
  }

  /** The segments of a variant it wrote since its output may be published. */
  private async publishableSegments(generation: Generation, variant: Variant): Promise<PlaylistSegment[]> {
    const from = generation.publishFrom[variant];
    const written = from === undefined ? [] : await this.segmentsOf(generation, variant);
    return written.filter((segment) => segmentIndex(segment.uri) > (from ?? Infinity));
  }

  private async segmentsOf(generation: Generation, variant: Variant): Promise<PlaylistSegment[]> {
    const text = await readFile(join(generation.directory, variant, "index.m3u8"), "utf8").catch(() => "");
    return parseMediaPlaylist(text).segments;
  }

  /**
   * A source whose live edge stopped: ffmpeg stops reading it, so it can't turn the engine's old
   * window into segments, and none of it is published from now on. The controller replaces it.
   * Its live edge is still followed: the engine may notice the broadcast is back before that.
   */
  private stopIfStale(generation: Generation): void {
    if (generation.staleStopped || !generation.stale()) {
      return;
    }
    generation.staleStopped = true;
    const liveEdge = generation.watch?.edge.view();
    const seconds = String(Math.round(this.liveEdge.staleAfterMs / 1000));
    const behind = (liveEdge?.behindSeconds ?? 0) * 1000 > this.liveEdge.staleAfterMs;
    generation.error = behind
      ? `stopped reading: the engine serves the broadcast more than ${seconds}s behind its live edge`
      : `stopped reading: the broadcast's live edge did not move for ${seconds}s`;
    generation.halt();
    this.logger.warn({ generation: generation.number, liveEdge }, "live edge stopped; stopped reading the source");
  }

  /** Published segments older than the stale threshold leave the playlists. */
  private expireOldSegments(): void {
    const before = this.now() - this.liveEdge.staleAfterMs;
    for (const variant of VARIANTS) {
      this.playlists[variant].expire(before);
    }
  }

  /**
   * Starts ffmpeg again on the same source when its run goes on but is stuck (see `StuckRuns`), with
   * the full stream re-encoded from then on when a copy can't be cut (`SourceFeeds.copyFails`). The
   * old run is killed outright: as it stops, ffmpeg would write out all it holds. A full output
   * that stalled shows the broadcast's key frames are gone, which decoding key frames only needs
   * too: the stream's later runs decode every frame (see `KeyFrames`). Until the new run has video
   * of its own, the stream's last video is the old run's, and the controller gives the new run
   * time to start (see `PipelineStatus.restartedAt`).
   */
  private restartIfStuck(generation: Generation): boolean {
    const stuck = this.stuck.check(generation);
    if (stuck === undefined) {
      return false;
    }
    this.logger.warn({ generation: generation.number, ...stuck.details }, stuck.message);
    generation.process?.kill("SIGKILL");
    this.feeds.copyFails ||= stuck.reencode;
    this.keyFrames.allFrames ||= stuck.reason === "full-output-stalled";
    this.restartedAt = this.now();
    const { source, inputTimeoutSeconds, stat } = generation;
    this.swap(generation, this.prepare(source, inputTimeoutSeconds, REOPENS_AFTER_FALLBACK, stat), stuck.reason);
    return true;
  }

  /** Promotes the pending generation once it has a segment, or gives up on it. */
  private async syncPending(): Promise<void> {
    const pending = this.pending;
    if (pending === undefined) {
      return;
    }
    const publishable = (await this.openGate(pending)) ? await this.publishableSegments(pending, "full") : [];
    if (pending !== this.pending) {
      // Another sync (for a player's playlist request) dealt with it meanwhile.
      return;
    }
    const timedOut = this.now() - pending.handoverSince > this.settings.handoverTimeoutMs;
    if (publishable.length > 0) {
      this.promote(pending);
    } else if (pending.stale()) {
      // Its engine serves an old window: it would never take over.
      this.logger.warn(
        { generation: pending.number, liveEdge: pending.watch?.edge.view() },
        "handover failed: stale source",
      );
      this.retire(pending);
      this.pending = undefined;
      this.events.handover(this.id, "failed");
    } else if (pending.willReopen() && !timedOut) {
      if (this.mayReopenNow(pending)) {
        this.reopen(pending);
      }
    } else if (!timedOut && this.fallBackToAllFrames(pending)) {
      // Its ffmpeg starts again, and the handover goes on with that run.
    } else if (pending.state === "exited" || timedOut) {
      const stderr = pending.stderrTail.slice(-5);
      this.logger.warn({ generation: pending.number, error: pending.error, stderr }, "handover failed");
      this.retire(pending);
      this.pending = undefined;
      this.events.handover(this.id, "failed");
    }
  }

  private mayReopenNow(generation: Generation): boolean {
    return generation.willReopen() && this.now() - generation.startedAt >= REOPEN_DELAY_MS;
  }

  /** Starts ffmpeg again on the source of a run that failed before any video (see `start`). */
  private reopen(generation: Generation): void {
    const next = this.prepare(
      generation.source,
      generation.inputTimeoutSeconds,
      generation.reopens - 1,
      generation.stat,
    );
    this.logger.info(
      { generation: generation.number, stderr: generation.stderrTail.slice(-5), reopensLeft: next.reopens },
      "ffmpeg failed before any video; opening the source again",
    );
    this.swap(generation, next, "reopen");
  }

  /**
   * Starts `next`, a new run on the source of `generation`, in its place: it stops, and a handover
   * it was part of goes on with `next`. Nothing waits, so no other sync starts a second one.
   */
  private swap(generation: Generation, next: Generation, reason: string): void {
    next.handoverSince = generation.handoverSince;
    // The last frame players got of this source, until `next` has one: a run that took over
    // mid-stream carries it, as does one that replaced a stuck run (see `restartIfStuck`).
    next.publishedFrameAt = generation.publishedFrameAt;
    this[generation === this.pending ? "pending" : "active"] = next;
    this.retire(generation);
    void this.run(next, reason).catch((error: unknown) => {
      next.state = "exited";
      next.error = error instanceof Error ? error.message : String(error);
    });
  }

  /**
   * Starts a run that decodes every frame in place of one that decodes key frames only, when that
   * one read the source for `KEY_FRAMES_PATIENCE_MS` without a single frame coming of it: the
   * broadcast has no key frames ffmpeg can use (see `decodesKeyFramesOnly`), so the previews and
   * thumbnails never start. The full stream is copied and plays, but with no frame counted the
   * controller takes the stream for dead. Every later run of the stream decodes every frame too.
   */
  private fallBackToAllFrames(generation: Generation): boolean {
    if (!this.keyFrames.fallBack(generation, this.planOf(generation), this.now())) {
      return false;
    }
    this.logger.warn({ generation: generation.number }, "key frames only decoding gave no frame; decoding every frame");
    const { source, inputTimeoutSeconds, stat } = generation;
    this.swap(generation, this.prepare(source, inputTimeoutSeconds, REOPENS_AFTER_FALLBACK, stat), "all-frames");
    return true;
  }

  private promote(pending: Generation): void {
    const previous = this.active;
    this.active = pending;
    this.pending = undefined;
    // Players get another source from here on: what the old one's layout did is not about it.
    this.layoutChangedAt = undefined;
    if (previous !== undefined) {
      this.retire(previous);
    }
    this.logger.info({ generation: pending.number }, "handover complete");
    this.events.handover(this.id, "promoted");
  }

  /** The input timeout of a handover: the usual one, or the handover timeout when that is longer. */
  private handoverInputTimeoutSeconds(): number {
    return Math.max(this.settings.plan.inputTimeoutSeconds, Math.ceil(this.settings.handoverTimeoutMs / 1000));
  }

  private async launch(
    source: string,
    reason: string,
    inputTimeoutSeconds: number,
    reopens = 0,
    stat?: string,
  ): Promise<Generation> {
    const generation = this.prepare(source, inputTimeoutSeconds, reopens, stat);
    await this.run(generation, reason);
    return generation;
  }

  /** A new generation for the source, not running yet. */
  private prepare(source: string, inputTimeoutSeconds: number, reopens: number, stat: string | undefined): Generation {
    const generation = this.create({ source, stat, inputTimeoutSeconds, mode: this.feeds.startMode() });
    generation.reopens = reopens;
    if (stat !== undefined) {
      generation.watch = this.watchLiveEdge(stat, new LiveEdge(this.liveEdge, this.now, this.newestEdge()));
    }
    return generation;
  }

  private create(
    plan: Pick<GenerationPlan, "source" | "stat" | "inputTimeoutSeconds" | "mode" | "midStream">,
  ): Generation {
    const number = this.nextNumber;
    this.nextNumber += 1;
    const directory = join(this.root, `g${String(number)}`);
    return new Generation({ ...plan, number, directory, allFrames: this.keyFrames.allFrames, startedAt: this.now() });
  }

  /**
   * `SourceFeeds` found that `old` can't go on with its source as it is: the stream's video needs
   * the other mode, or the broadcast changed its layout mid-stream (ffmpeg stays on the streams it
   * found at its start, so it would get no more video). Starts a run in its place that reads on
   * from here, on the same connection: the reader ends the old run's input and gives the new one
   * the stream's tables and everything after them. With `how.drain`, what the old run still writes
   * out is published before the new run's output, so players get the old run to its last frame.
   */
  private succeed(old: Generation, how: Succession, reason: string): Generation | undefined {
    const slot = [this.active, this.pending].indexOf(old);
    if (slot === -1 || old.retired || this.stopped) {
      return undefined;
    }
    const { source, stat, inputTimeoutSeconds } = old;
    const next = this.create({ source, stat, inputTimeoutSeconds, mode: how.mode, midStream: how.midStream });
    next.takeOver(old, how.layout);
    this[slot === 0 ? "active" : "pending"] = next;
    if (how.change !== undefined && slot === 0 && old.frames > 0) {
      // Players get no new video until the new run has some out: the controller allows for that
      // (see `PipelineStatus.layoutChangedAt`), but only after a run that had video of its own.
      // Tables that keep changing over a stream without video must not look like one that has it.
      this.layoutChangedAt = this.now();
    }
    try {
      makeRunDirectoryNow(next.directory);
      this.spawn(next, reason);
    } catch (error) {
      next.state = "exited";
      next.error = error instanceof Error ? error.message : String(error);
      // Nothing takes the source's data.
      next.halt();
    }
    // A source that waits to take over has published nothing yet: its new run starts that.
    if (how.drain && slot === 0) {
      this.feeds.drainLater(old);
    } else {
      this.retire(old);
    }
    return next;
  }

  /**
   * The newest live edge any of the stream's sources showed so far, with the latest time any of
   * them found the broadcast sending new data (that is the stream's, not one source's).
   */
  private newestEdge(also?: Generation): LiveEdgeSeed | undefined {
    let newest = this.lastEdge;
    for (const generation of [this.active, this.pending, also]) {
      newest = newerSeed(newest, generation?.watch?.edge.snapshot());
    }
    return newest;
  }

  /** What the generation's ffmpeg does. */
  private planOf(generation: Generation): FfmpegPlan {
    const { directory, mode: fullMode, allFrames, midStream, inputTimeoutSeconds } = generation;
    return { ...this.settings.plan, directory, fullMode, allFrames, midStream, inputTimeoutSeconds };
  }

  /** Starts the generation's ffmpeg on its source, unless it was retired or the pipeline stopped meanwhile. */
  private async run(generation: Generation, reason: string): Promise<void> {
    await makeRunDirectory(generation.directory);
    if (generation.retired || this.stopped) {
      generation.state = "exited";
      return;
    }
    this.spawn(generation, reason);
    this.feeds.open(generation);
  }

  private spawn(generation: Generation, reason: string): void {
    const { number, mode, midStream, inputTimeoutSeconds } = generation;
    const args = buildFfmpegArgs(this.planOf(generation));
    this.logger.info({ generation: number, mode, reason, midStream, inputTimeoutSeconds }, "starting ffmpeg");
    this.events.generationStarted(this.id, reason);
    attachFfmpeg(generation, this.spawner(this.settings.ffmpegPath, args), {
      now: this.now,
      onFrames: (block) => {
        this.keyFrames.progressed(block, this.planOf(generation));
      },
      onVideoCodec: (codec) => {
        this.onVideoCodec(generation, codec);
      },
      onExit: (code, signal) => {
        this.logger.info({ generation: number, code, signal, error: generation.error }, "ffmpeg exited");
      },
    });
  }

  /**
   * ffmpeg found the codec of the source's video. The run's mode is usually right by then (see
   * `SourceFeeds`); where the source's tables didn't tell, a run in the wrong mode ends here, before
   * it wrote anything, and one in the right mode opens the source again.
   */
  private onVideoCodec(generation: Generation, codec: string): void {
    const current = generation === this.active || generation === this.pending;
    if (!current || generation.retired || this.stopped) {
      return;
    }
    const mode = this.feeds.found(generation, codec);
    if (mode === generation.mode) {
      return;
    }
    const what = mode === "transcode" ? "source is not H.264; re-encoding" : "source is H.264; copying";
    this.logger.info({ generation: generation.number, codec }, `${what} the full stream`);
    const { source, inputTimeoutSeconds, reopens, stat } = generation;
    this.swap(generation, this.prepare(source, inputTimeoutSeconds, reopens, stat), mode);
  }

  /**
   * Stops a generation and removes its files once players can no longer reference them. Once the
   * pipeline has stopped, its stop has removed them all: a timer could then only remove the files
   * of the stream's next pipeline, which starts with the same names.
   */
  private retire(generation: Generation): void {
    generation.retired = true;
    this.keyFrames.ended(generation);
    this.lastEdge = this.newestEdge(generation);
    generation.watch?.stop();
    generation.halt();
    if (!this.stopped) {
      generation.removeLater(OLD_GENERATION_TTL_MS, this.retiredRuns);
    }
  }
}
