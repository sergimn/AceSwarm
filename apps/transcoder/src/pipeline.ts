import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineState, PipelineStatus } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import { buildFfmpegArgs, type FfmpegPlan, type FullMode } from "./ffmpeg-args.ts";
import { parseMediaPlaylist, VirtualPlaylist } from "./playlist.ts";
import { parseInputVideoCodec, ProgressParser } from "./progress.ts";

export type Variant = "full" | "preview";
export const VARIANTS: readonly Variant[] = ["full", "preview"];

export type PlanSettings = Omit<FfmpegPlan, "source" | "directory" | "fullMode">;

export interface PipelineSettings {
  hlsDir: string;
  ffmpegPath: string;
  handoverTimeoutMs: number;
  plan: PlanSettings;
}

export interface PipelineEvents {
  generationStarted: (id: string, reason: string) => void;
  handover: (id: string, result: "promoted" | "failed") => void;
}

export type Spawner = (command: string, args: string[]) => ChildProcess;

const defaultSpawner: Spawner = (command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

/** Browsers only decode H.264 reliably, so other codecs are re-encoded for the full output. */
const COPYABLE_CODECS = new Set(["h264"]);
const OLD_GENERATION_TTL_MS = 60_000;
const KILL_GRACE_MS = 3000;
/** How long after a run that failed before any video ffmpeg opens its source again (see `start`). */
const REOPEN_DELAY_MS = 1000;

class Generation {
  readonly number: number;
  readonly source: string;
  readonly directory: string;
  readonly mode: FullMode;
  readonly startedAt: number;
  /** How long ffmpeg waits for data from the source before it gives up. */
  readonly inputTimeoutSeconds: number;
  process: ChildProcess | undefined;
  state: PipelineState = "starting";
  frames = 0;
  lastFrameAt: number | undefined;
  fps: number | undefined;
  videoCodec: string | undefined;
  exitCode: number | null = null;
  error: string | null = null;
  readonly stderrTail: string[] = [];
  /** How many more times ffmpeg opens the source again when this run fails before any video. */
  reopens = 0;
  /** When the handover this run is for began: the first run's start, for a run that reopened. */
  handoverSince: number;
  /** Stopped for good: another generation took its place, or none is needed any more. */
  retired = false;

  constructor(
    number: number,
    source: string,
    directory: string,
    mode: FullMode,
    startedAt: number,
    inputTimeoutSeconds: number,
  ) {
    this.number = number;
    this.source = source;
    this.directory = directory;
    this.mode = mode;
    this.startedAt = startedAt;
    this.inputTimeoutSeconds = inputTimeoutSeconds;
    this.handoverSince = startedAt;
  }

  /** Whether ffmpeg failed before any video, and opens the source again. */
  willReopen(): boolean {
    return this.state === "exited" && this.frames === 0 && this.reopens > 0 && !this.retired;
  }
}

/**
 * The ffmpeg work of one stream. A new source starts a new generation in its own directory;
 * players see a single continuous playlist because {@link VirtualPlaylist} stitches generations.
 * With handover, the new generation runs next to the old one and only takes over once it has
 * produced its first segment (make-before-break).
 */
export class Pipeline {
  readonly id: string;
  private readonly settings: PipelineSettings;
  private readonly logger: Logger;
  private readonly events: PipelineEvents;
  private readonly spawner: Spawner;
  private readonly now: () => number;
  private readonly root: string;
  private readonly playlists: Record<Variant, VirtualPlaylist>;
  private active: Generation | undefined;
  private pending: Generation | undefined;
  private nextNumber = 1;
  private forceTranscode = false;
  private lastThumbnail: string | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    id: string,
    settings: PipelineSettings,
    logger: Logger,
    events: PipelineEvents,
    spawner: Spawner = defaultSpawner,
    now: () => number = Date.now,
  ) {
    this.id = id;
    this.settings = settings;
    this.logger = logger.child({ stream: id });
    this.events = events;
    this.spawner = spawner;
    this.now = now;
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
   */
  async start(source: string, handover: boolean, reopens = 0): Promise<void> {
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
      const launched = await this.launch(source, "handover", inputTimeoutSeconds, reopens);
      this.replace("pending", launched);
      return;
    }
    const previous = this.active;
    const reason = previous === undefined ? "start" : "restart";
    const launched = await this.launch(source, reason, inputTimeoutSeconds, reopens);
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
      };
    }
    return {
      id: this.id,
      // A run that failed before any video and opens its source again is still starting.
      state: generation.willReopen() ? "starting" : generation.state,
      source: generation.source,
      startedAt: new Date(generation.startedAt).toISOString(),
      lastFrameAt: generation.lastFrameAt === undefined ? null : new Date(generation.lastFrameAt).toISOString(),
      frames: generation.frames,
      fps: generation.fps ?? null,
      videoCodec: generation.videoCodec ?? null,
      mode: generation.mode,
      exitCode: generation.exitCode,
      error: generation.error,
      pendingSource,
    };
  }

  async playlist(variant: Variant): Promise<string | undefined> {
    await this.sync();
    return this.playlists[variant].render();
  }

  thumbnailPath(): string | undefined {
    const candidate = this.active === undefined ? undefined : join(this.active.directory, "thumbnail.jpg");
    if (candidate !== undefined && existsSync(candidate)) {
      this.lastThumbnail = candidate;
    }
    return this.lastThumbnail !== undefined && existsSync(this.lastThumbnail) ? this.lastThumbnail : undefined;
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
      }
    }
    this.active = undefined;
    this.pending = undefined;
    await rm(this.root, { recursive: true, force: true });
  }

  /** Copies new segments into the virtual playlists and completes pending handovers. */
  async sync(): Promise<void> {
    await this.syncPending();
    const active = this.active;
    if (active === undefined) {
      return;
    }
    if (this.mayReopenNow(active)) {
      this.reopen(active);
      return;
    }
    for (const variant of VARIANTS) {
      const text = await readFile(join(active.directory, variant, "index.m3u8"), "utf8").catch(() => undefined);
      if (text !== undefined) {
        const parsed = parseMediaPlaylist(text);
        this.playlists[variant].append(active.number, parsed.segments, `../g${String(active.number)}/${variant}/`);
      }
    }
  }

  /** Promotes the pending generation once it has a segment, or gives up on it. */
  private async syncPending(): Promise<void> {
    const pending = this.pending;
    if (pending === undefined) {
      return;
    }
    const ready = await this.hasSegment(pending);
    if (pending !== this.pending) {
      // Another sync (for a player's playlist request) dealt with it meanwhile.
      return;
    }
    const timedOut = this.now() - pending.handoverSince > this.settings.handoverTimeoutMs;
    if (ready) {
      this.promote(pending);
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
    const next = this.prepare(generation.source, generation.inputTimeoutSeconds, generation.reopens - 1);
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

  private async hasSegment(generation: Generation): Promise<boolean> {
    const text = await readFile(join(generation.directory, "full", "index.m3u8"), "utf8").catch(() => "");
    return parseMediaPlaylist(text).segments.length > 0;
  }

  /** The input timeout of a handover: the usual one, or the handover timeout when that is longer. */
  private handoverInputTimeoutSeconds(): number {
    return Math.max(this.settings.plan.inputTimeoutSeconds, Math.ceil(this.settings.handoverTimeoutMs / 1000));
  }

  private async launch(source: string, reason: string, inputTimeoutSeconds: number, reopens = 0): Promise<Generation> {
    const generation = this.prepare(source, inputTimeoutSeconds, reopens);
    await this.run(generation, reason);
    return generation;
  }

  /** A new generation for the source, not running yet. */
  private prepare(source: string, inputTimeoutSeconds: number, reopens: number): Generation {
    const number = this.nextNumber;
    this.nextNumber += 1;
    const directory = join(this.root, `g${String(number)}`);
    const mode = this.forceTranscode ? "transcode" : "copy";
    const generation = new Generation(number, source, directory, mode, this.now(), inputTimeoutSeconds);
    generation.reopens = reopens;
    return generation;
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
      this.active = await this.launch(generation.source, "transcode", generation.inputTimeoutSeconds);
    } else if (generation === this.pending) {
      this.retire(generation);
      this.pending = await this.launch(generation.source, "transcode", generation.inputTimeoutSeconds);
    }
  }

  /** Stops a generation and removes its files once players can no longer reference them. */
  private retire(generation: Generation): void {
    generation.retired = true;
    killProcess(generation.process);
    const timer = setTimeout(() => {
      void rm(generation.directory, { recursive: true, force: true });
    }, OLD_GENERATION_TTL_MS);
    timer.unref();
  }
}

function killProcess(child: ChildProcess | undefined): void {
  if (child?.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, KILL_GRACE_MS);
  timer.unref();
}

function lastErrorLine(lines: string[], code: number | null): string {
  const interesting = lines.findLast((line) => /error|failed|invalid|timed out|refused/i.test(line));
  return interesting ?? `ffmpeg exited with code ${String(code)}`;
}
