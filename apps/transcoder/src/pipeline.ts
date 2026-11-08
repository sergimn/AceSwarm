import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import { buildFfmpegArgs, type FfmpegPlan } from "./ffmpeg-args.ts";
import { Generation, killProcess, lastErrorLine, modifiedAt, VARIANTS, type Variant } from "./generation.ts";
import {
  DEFAULT_LIVE_EDGE_SETTINGS,
  LiveEdge,
  watchLiveEdge as defaultWatch,
  type LiveEdgeSeed,
  type LiveEdgeSettings,
  type WatchLiveEdge,
} from "./live-edge.ts";
import { parseMediaPlaylist, segmentIndex, VirtualPlaylist, type PlaylistSegment } from "./playlist.ts";
import { parseInputVideoCodec, ProgressParser } from "./progress.ts";

export { VARIANTS, type Variant } from "./generation.ts";

export type PlanSettings = Omit<FfmpegPlan, "source" | "directory" | "fullMode">;

export interface PipelineSettings {
  hlsDir: string;
  ffmpegPath: string;
  handoverTimeoutMs: number;
  plan: PlanSettings;
  /**
   * When a source's live edge counts as stale (see `LiveEdge`). Published segments older than its
   * `staleAfterMs` also leave the playlist, so a player never starts on old video.
   */
  liveEdge?: LiveEdgeSettings;
}

export interface PipelineEvents {
  generationStarted: (id: string, reason: string) => void;
  handover: (id: string, result: "promoted" | "failed") => void;
}

export type Spawner = (command: string, args: string[]) => ChildProcess;

/** What tests replace: how ffmpeg starts, the clock, and how a source's live edge is followed. */
export interface PipelineOptions {
  spawner?: Spawner | undefined;
  now?: () => number;
  watchLiveEdge?: WatchLiveEdge;
}

const defaultSpawner: Spawner = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

/** Browsers only decode H.264 reliably, so other codecs are re-encoded for the full output. */
const COPYABLE_CODECS = new Set(["h264"]);
const OLD_GENERATION_TTL_MS = 60_000;
/** How long after a run that failed before any video ffmpeg opens its source again (see `start`). */
const REOPEN_DELAY_MS = 1000;

/**
 * The ffmpeg work of one stream. A new source starts a new generation in its own directory;
 * players see a single continuous playlist because {@link VirtualPlaylist} stitches generations.
 * With handover, the new generation runs next to the old one and only takes over once it has
 * produced its first segment (make-before-break).
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
  private nextNumber = 1;
  private forceTranscode = false;
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
   * Points the pipeline at a (new) source. With `handover`, ffmpeg's input timeout (how long any
   * read may wait, for the whole run) is at least the handover timeout, even when there is no
   * picture left to keep: a new engine on a slow swarm can take longer than the usual input timeout
   * to deliver its first data, and the controller waits the whole handover for it.
   *
   * With `reopens`, ffmpeg opens the source again up to that many times when it fails before any
   * video: an engine that has just lost another reader of the session may refuse a new one for a
   * moment (it allows one reader per session).
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
    if (generation === undefined) {
      return {
        id: this.id,
        state: "exited",
        source: "",
        startedAt: new Date(this.now()).toISOString(),
        lastFrameAt: null,
        frames: 0,
        fps: null,
        videoCodec: null,
        mode: "copy",
        exitCode: null,
        error: "not started",
        pendingSource,
        liveEdge: null,
      };
    }
    return {
      id: this.id,
      // A run that failed before any video and opens its source again is still starting.
      state: generation.willReopen() ? "starting" : generation.state,
      source: generation.source,
      startedAt: new Date(generation.startedAt).toISOString(),
      // Only video players could get: none while a new source's live edge hasn't moved yet.
      lastFrameAt:
        generation.publishedFrameAt === undefined ? null : new Date(generation.publishedFrameAt).toISOString(),
      frames: generation.frames,
      fps: generation.fps ?? null,
      videoCodec: generation.videoCodec ?? null,
      mode: generation.mode,
      exitCode: generation.exitCode,
      error: generation.error,
      pendingSource,
      liveEdge: generation.watch?.edge.view() ?? null,
    };
  }

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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.syncTimer !== undefined) {
      clearInterval(this.syncTimer);
    }
    for (const generation of [this.active, this.pending]) {
      if (generation !== undefined) {
        killProcess(generation.process);
        generation.watch?.stop();
      }
    }
    this.active = undefined;
    this.pending = undefined;
    await rm(this.root, { recursive: true, force: true });
  }

  /** Copies new segments into the virtual playlists and completes pending handovers. */
  async sync(): Promise<void> {
    await this.syncPending();
    this.expireOldSegments();
    const active = this.active;
    if (active === undefined) {
      return;
    }
    this.stopIfStale(active);
    if (this.mayReopenNow(active)) {
      this.reopen(active);
      return;
    }
    if (!(await this.openGate(active)) || active !== this.active) {
      return;
    }
    for (const variant of VARIANTS) {
      const segments = await this.publishableSegments(active, variant);
      if (segments.length > 0 && active === this.active) {
        const prefix = `../g${String(active.number)}/${variant}/`;
        const added = this.playlists[variant].append(active.number, segments, prefix, this.now());
        if (variant === "full" && added > 0 && !active.published) {
          // Its video counts from now on: players can get it.
          active.published = true;
          active.publishedFrameAt = active.lastFrameAt;
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
    killProcess(generation.process);
    this.logger.warn({ generation: generation.number, liveEdge }, "live edge stopped; stopped reading the source");
  }

  /** Published segments older than the stale threshold leave the playlists. */
  private expireOldSegments(): void {
    const before = this.now() - this.liveEdge.staleAfterMs;
    for (const variant of VARIANTS) {
      this.playlists[variant].expire(before);
    }
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
    next.handoverSince = generation.handoverSince;
    if (generation === this.pending) {
      this.pending = next;
    } else {
      this.active = next;
    }
    this.retire(generation);
    this.logger.info(
      { generation: generation.number, stderr: generation.stderrTail.slice(-5), reopensLeft: next.reopens },
      "ffmpeg failed before any video; opening the source again",
    );
    void this.run(next, "reopen").catch((error: unknown) => {
      next.state = "exited";
      next.error = error instanceof Error ? error.message : String(error);
    });
  }

  private promote(pending: Generation): void {
    const previous = this.active;
    this.active = pending;
    this.pending = undefined;
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
    const number = this.nextNumber;
    this.nextNumber += 1;
    const directory = join(this.root, `g${String(number)}`);
    const mode = this.forceTranscode ? "transcode" : "copy";
    const generation = new Generation({
      number,
      source,
      stat,
      directory,
      mode,
      startedAt: this.now(),
      inputTimeoutSeconds,
    });
    generation.reopens = reopens;
    if (stat !== undefined) {
      generation.watch = this.watchLiveEdge(stat, new LiveEdge(this.liveEdge, this.now, this.newestEdge()));
    }
    return generation;
  }

  /** The newest live edge any of the stream's sources showed so far. */
  private newestEdge(also?: Generation): LiveEdgeSeed | undefined {
    let newest = this.lastEdge;
    for (const generation of [this.active, this.pending, also]) {
      const seen = generation?.watch?.edge.snapshot();
      if (seen !== undefined && (newest === undefined || seen.edge >= newest.edge)) {
        newest = seen;
      }
    }
    return newest;
  }

  /** Starts the generation's ffmpeg, unless it was retired or the pipeline stopped meanwhile. */
  private async run(generation: Generation, reason: string): Promise<void> {
    const { number, source, directory, inputTimeoutSeconds } = generation;
    await mkdir(join(directory, "full"), { recursive: true });
    await mkdir(join(directory, "preview"), { recursive: true });
    if (generation.retired || this.stopped) {
      generation.state = "exited";
      return;
    }
    const args = buildFfmpegArgs({
      ...this.settings.plan,
      source,
      directory,
      fullMode: generation.mode,
      inputTimeoutSeconds,
    });
    this.logger.info({ generation: number, mode: generation.mode, reason, inputTimeoutSeconds }, "starting ffmpeg");
    this.events.generationStarted(this.id, reason);

    const child = this.spawner(this.settings.ffmpegPath, args);
    generation.process = child;
    const progress = new ProgressParser();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const block of progress.push(chunk)) {
        if (block.frame !== undefined && block.frame > generation.frames) {
          generation.frames = block.frame;
          generation.lastFrameAt = this.now();
          generation.state = "running";
          if (generation.publishing() && generation.published) {
            generation.publishedFrameAt = generation.lastFrameAt;
          }
        }
        generation.fps = block.fps;
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        this.onStderrLine(generation, line);
      }
    });
    child.on("error", (error) => {
      generation.state = "exited";
      generation.error = error.message;
    });
    child.on("exit", (code, signal) => {
      generation.state = "exited";
      generation.exitCode = code;
      generation.error ??= signal === null ? lastErrorLine(generation.stderrTail, code) : `killed by ${signal}`;
      this.logger.info({ generation: generation.number, code, signal, error: generation.error }, "ffmpeg exited");
    });
  }

  private onStderrLine(generation: Generation, line: string): void {
    if (line.trim().length === 0) {
      return;
    }
    generation.stderrTail.push(line.trim());
    if (generation.stderrTail.length > 20) {
      generation.stderrTail.shift();
    }
    const codec = generation.videoCodec === undefined ? parseInputVideoCodec(line) : undefined;
    if (codec === undefined) {
      return;
    }
    generation.videoCodec = codec;
    if (generation.mode !== "copy" || COPYABLE_CODECS.has(codec) || this.stopped) {
      return;
    }

    this.logger.info({ codec }, "source is not H.264; re-encoding the full stream");
    this.forceTranscode = true;
    void this.relaunchAsTranscode(generation);
  }

  private async relaunchAsTranscode(generation: Generation): Promise<void> {
    if (generation === this.active) {
      this.retire(generation);
      this.active = await this.launch(
        generation.source,
        "transcode",
        generation.inputTimeoutSeconds,
        0,
        generation.stat,
      );
    } else if (generation === this.pending) {
      this.retire(generation);
      this.pending = await this.launch(
        generation.source,
        "transcode",
        generation.inputTimeoutSeconds,
        0,
        generation.stat,
      );
    }
  }

  /** Stops a generation and removes its files once players can no longer reference them. */
  private retire(generation: Generation): void {
    generation.retired = true;
    this.lastEdge = this.newestEdge(generation);
    generation.watch?.stop();
    killProcess(generation.process);
    const timer = setTimeout(() => {
      void rm(generation.directory, { recursive: true, force: true });
    }, OLD_GENERATION_TTL_MS);
    timer.unref();
  }
}
