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
   * Points the pipeline at a (new) source. With `handover`, ffmpeg waits for the source's first data
   * as long as the controller waits for the handover, even when there is no picture left to keep:
   * a new engine on a slow swarm can take longer than the usual input timeout to deliver.
   */
  async start(source: string, handover: boolean): Promise<void> {
    const inputTimeoutSeconds = handover ? this.handoverInputTimeoutSeconds() : this.settings.plan.inputTimeoutSeconds;
    const canHandOver = handover && this.active !== undefined && this.active.state !== "exited";
    if (canHandOver) {
      if (this.pending !== undefined) {
        this.retire(this.pending);
      }
      this.pending = await this.launch(source, "handover", inputTimeoutSeconds);
      return;
    }
    if (this.pending !== undefined) {
      this.retire(this.pending);
      this.pending = undefined;
    }
    const previous = this.active;
    this.active = await this.launch(source, previous === undefined ? "start" : "restart", inputTimeoutSeconds);
    if (previous !== undefined) {
      this.retire(previous);
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
      state: generation.state,
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
    const pending = this.pending;
    if (pending !== undefined) {
      if (await this.hasSegment(pending)) {
        this.promote(pending);
      } else if (pending.state === "exited" || this.now() - pending.startedAt > this.settings.handoverTimeoutMs) {
        this.logger.warn({ generation: pending.number, error: pending.error }, "handover failed");
        this.retire(pending);
        this.pending = undefined;
        this.events.handover(this.id, "failed");
      }
    }
    const active = this.active;
    if (active === undefined) {
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

  private async launch(source: string, reason: string, inputTimeoutSeconds: number): Promise<Generation> {
    const number = this.nextNumber;
    this.nextNumber += 1;
    const directory = join(this.root, `g${String(number)}`);
    await mkdir(join(directory, "full"), { recursive: true });
    await mkdir(join(directory, "preview"), { recursive: true });
    const generation = new Generation(
      number,
      source,
      directory,
      this.forceTranscode ? "transcode" : "copy",
      this.now(),
      inputTimeoutSeconds,
    );
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
    return generation;
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
