import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@aceswarm/shared/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEdge } from "../src/live-edge.ts";
import { Pipeline, type PipelineSettings } from "../src/pipeline.ts";
import { fakeSources, type FakeSource } from "./fake-source.ts";

/** An ffmpeg process that never delivers anything, as with an engine still looking for peers. */
function silentProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => {
      Object.assign(child, { killed: true });
      return true;
    },
  });
  return child;
}

/** An ffmpeg run that ends, as when the engine refuses the connection. */
function exit(child: ChildProcess | undefined, code = 183): void {
  Object.assign(child ?? {}, { exitCode: code });
  (child?.stderr as PassThrough | undefined)?.write(
    "Error opening input files: Invalid data found when processing input\n",
  );
  child?.emit("exit", code, null);
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe("Pipeline", () => {
  let hlsDir: string;
  let pipeline: Pipeline | undefined;
  /** The arguments of every ffmpeg run, in order. */
  const runs: string[][] = [];
  /** Every ffmpeg process, in the same order. */
  const children: ChildProcess[] = [];
  /** The source each run opened, in the same order: every run of these tests reads its own. */
  let opened: FakeSource[] = [];
  /** The source a run reads. */
  const sourceOf = (run: number): string | undefined => opened[run]?.request.source;
  /** How long a run's reader waits for data, in milliseconds. */
  const inputTimeout = (run: number): number | undefined => opened[run]?.request.idleTimeoutMs;
  const streamLogger = createLogger("test", "silent");

  beforeEach(async () => {
    hlsDir = await mkdtemp(join(tmpdir(), "pipeline-test-"));
    runs.length = 0;
    children.length = 0;
  });

  afterEach(async () => {
    await pipeline?.stop();
    await rm(hlsDir, { recursive: true, force: true });
  });

  function start(handoverTimeoutSeconds: number, now: () => number = Date.now): Pipeline {
    const settings: PipelineSettings = {
      hlsDir,
      ffmpegPath: "ffmpeg",
      handoverTimeoutMs: handoverTimeoutSeconds * 1000,
      plan: {
        previewMode: "video",
        previewHeight: 270,
        previewFps: 15,
        previewBitrateKbps: 400,
        fullTranscodeMaxHeight: 1080,
        audioBitrateKbps: 128,
        segmentSeconds: 2,
        playlistSize: 6,
        thumbnailIntervalSeconds: 10,
        inputTimeoutSeconds: 60,
      },
    };
    const events = { generationStarted: () => undefined, handover: () => undefined };
    const logger = createLogger("test", "silent");
    const sources = fakeSources();
    opened = sources.opened;
    vi.spyOn(logger, "child").mockReturnValue(streamLogger as never);
    pipeline = new Pipeline("s1", settings, logger, events, {
      spawner: (_command, args) => {
        runs.push(args);
        const child = silentProcess();
        children.push(child);
        return child;
      },
      now,
      openSource: sources.open,
    });
    return pipeline;
  }

  it("waits the usual input timeout for a source it starts without a handover", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-1/play-again", false);
    expect(opened.map((source) => source.request.idleTimeoutMs)).toEqual([60_000, 60_000]);
  });

  it("waits as long as the handover for a new engine's first data", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(1)).toBe(120_000);
    expect(instance.status().pendingSource).toBe("http://engine-2/play");
  });

  it("waits as long as the handover even when there is no picture left to keep", async () => {
    const instance = start(120);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(0)).toBe(120_000);
    expect(instance.status().source).toBe("http://engine-2/play");
  });

  it("keeps the handover's input timeout when the new source needs re-encoding", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    (children[1]?.stderr as PassThrough).write("  Stream #0:0: Video: hevc (Main), yuv420p, 1920x1080\n");
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    expect(runs[2]).toContain("libx264");
    expect(inputTimeout(2)).toBe(120_000);
    expect(instance.status().pendingSource).toBe("http://engine-2/play");
  });

  it("keeps the usual input timeout when the handover timeout is shorter", async () => {
    const instance = start(30);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(1)).toBe(60_000);
  });

  it("opens a handover's source again when ffmpeg fails before any video, as often as asked", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false);
    // The engine has just lost the standby's reader of this session, and refuses ffmpeg at first.
    await instance.start("http://engine-2/play", true, 2);
    exit(children[1]);
    await instance.sync();
    expect(runs).toHaveLength(2);
    expect(instance.status().pendingSource).toBe("http://engine-2/play");

    for (const run of [2, 3]) {
      clock.now += 1000;
      await instance.sync();
      await vi.waitFor(() => {
        expect(runs).toHaveLength(run + 1);
      });
      expect(sourceOf(run)).toBe("http://engine-2/play");
      expect(inputTimeout(run)).toBe(120_000);
      expect(instance.status().pendingSource).toBe("http://engine-2/play");
      exit(children[run]);
    }

    clock.now += 1000;
    await instance.sync();
    expect(runs).toHaveLength(4);
    expect(instance.status()).toMatchObject({ source: "http://engine-1/play", pendingSource: null });
  });

  it("gives up on a handover at once when ffmpeg fails and no reopen was asked", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    exit(children[1]);
    await instance.sync();
    expect(instance.status().pendingSource).toBeNull();
    expect(runs).toHaveLength(2);
  });

  it("does not open the source again once ffmpeg delivered video from it", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true, 2);
    (children[1]?.stdout as PassThrough).write("frame=12\nfps=25\nprogress=continue\n");
    await new Promise((resolve) => setImmediate(resolve));
    exit(children[1], 1);
    clock.now += 1000;
    await instance.sync();
    expect(runs).toHaveLength(2);
    expect(instance.status().pendingSource).toBeNull();
  });

  it("reports ffmpeg's frame rate only while ffmpeg runs", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    expect(instance.status().fps).toBeNull();
    // It starts on a window the engine has buffered, which it reads faster than real time.
    (children[0]?.stdout as PassThrough).write("frame=4370\nfps=873.95\nprogress=continue\n");
    await nextTurn();
    expect(instance.status()).toMatchObject({ state: "running", fps: 873.95 });

    // ffmpeg ends: what it printed last is not the frame rate of a stream that has none running.
    exit(children[0], 1);
    expect(instance.status()).toMatchObject({ state: "exited", fps: null });
    // A block it printed as it ended, read after its exit, still counts its frames, but leaves
    // the state as it is: no ffmpeg runs.
    (children[0]?.stdout as PassThrough).write("frame=4380\nfps=870.1\nprogress=end\n");
    await nextTurn();
    expect(instance.status()).toMatchObject({ state: "exited", exitCode: 1, fps: null, frames: 4380 });

    // The next run has none until it reports its own.
    await instance.start("http://engine-1/play", false);
    expect(instance.status().fps).toBeNull();
    (children[1]?.stdout as PassThrough).write("frame=12\nfps=25\nprogress=continue\n");
    await nextTurn();
    expect(instance.status().fps).toBe(25);
  });

  it("kills ffmpeg at once when it stops, and removes its files though ffmpeg writes some as it dies", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    const directory = join(hlsDir, "s1", "g1", "full");
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    let written = 0;
    // Files keep coming for a moment while the directory is being removed.
    Object.assign(children[0] ?? {}, {
      kill: (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        const until = performance.now() + 30;
        const write = (): void => {
          try {
            writeFileSync(join(directory, `seg_${String(written)}.ts`), "late");
          } catch {
            return;
          }
          written += 1;
          if (performance.now() < until) {
            setImmediate(write);
          }
        };
        setImmediate(write);
        return true;
      },
    });
    await instance.stop();
    expect(signals).toEqual(["SIGKILL"]);
    // The writes landed (a failed one ends them), so the removal had to deal with them.
    expect(written).toBeGreaterThan(0);
    expect(existsSync(join(hlsDir, "s1"))).toBe(false);
  });

  it("says in the log that ffmpeg was stopped with its stream, not killed from outside", async () => {
    const info = vi.spyOn(streamLogger, "info");
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.stop();
    children[0]?.emit("exit", null, "SIGKILL");
    expect(info).toHaveBeenCalledWith(
      { generation: 1, code: null, signal: "SIGKILL", error: "stopped with its stream" },
      "ffmpeg exited",
    );
  });

  it("says a restart that failed before any video is still starting until ffmpeg opens it again", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false);
    exit(children[0], 1);
    // No picture is left to keep, so the new source starts at once instead of a handover.
    await instance.start("http://engine-2/play", true, 1);
    exit(children[1]);
    expect(instance.status()).toMatchObject({ source: "http://engine-2/play", state: "starting" });

    clock.now += 1000;
    await instance.sync();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    expect(sourceOf(2)).toBe("http://engine-2/play");
    exit(children[2]);
    expect(instance.status()).toMatchObject({ source: "http://engine-2/play", state: "exited" });
  });

  it("leaves one ffmpeg running when a sync opens a source again while a restart starts", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false, 2);
    exit(children[0]);
    clock.now += 1000;
    await Promise.all([instance.start("http://engine-2/play", false), instance.sync()]);
    // The sync's run of the old source creates its directories before it would start ffmpeg.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const running = children.filter((child) => child.exitCode === null && !child.killed);
    expect(running.map((child) => sourceOf(children.indexOf(child)))).toEqual(["http://engine-2/play"]);
    expect(instance.status().source).toBe("http://engine-2/play");
  });

  it("gives up on a handover whose source keeps failing once the handover timeout passed", async () => {
    const clock = { now: 1000 };
    const instance = start(120, () => clock.now);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true, 5);
    exit(children[1]);
    clock.now += 60_000;
    await instance.sync();
    await vi.waitFor(() => {
      expect(runs).toHaveLength(3);
    });
    exit(children[2]);
    // The reopened run started a minute later, but the handover began two minutes ago.
    clock.now += 61_000;
    await instance.sync();
    expect(runs).toHaveLength(3);
    expect(instance.status().pendingSource).toBeNull();
  });

  /** A file ffmpeg wrote into the run's directory. */
  async function wrote(generation: number): Promise<string> {
    const file = join(hlsDir, "s1", `g${String(generation)}`, "full", "seg_000000.ts");
    await writeFile(file, "video");
    return file;
  }

  /**
   * The stream starts again after its pipeline stopped. The new pipeline replaces its first run
   * at once, so that those files are due in a minute (`due`), and its second run is live.
   */
  async function startedAgain(): Promise<{ due: string; live: string }> {
    const next = start(120);
    await next.start("http://engine-1/play", false);
    await next.start("http://engine-2/play", false);
    return { due: await wrote(1), live: await wrote(2) };
  }

  describe("when a retired run's files are removed", () => {
    const REMOVE_AFTER_MS = 60_000;

    beforeEach(() => {
      // Only the timers: the files are real, and the pipeline's syncs run on real time.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * A minute passes and the removals that came due run. They work on real files, so this waits for
     * the removal of `due`, a run's files that were to go, and a moment more for the others.
     */
    async function aMinutePasses(due: string): Promise<void> {
      await vi.advanceTimersByTimeAsync(REMOVE_AFTER_MS);
      await vi.waitFor(() => {
        expect(existsSync(due)).toBe(false);
      });
      await sleep(50);
    }

    it("removes the files of a run a minute after another replaced it, and only its files", async () => {
      const instance = start(120);
      await instance.start("http://engine-1/play", false);
      await instance.start("http://engine-2/play", false);
      const [retired, current] = [await wrote(1), await wrote(2)];
      await vi.advanceTimersByTimeAsync(REMOVE_AFTER_MS - 1);
      expect(existsSync(retired)).toBe(true);
      await aMinutePasses(retired);
      expect(existsSync(join(hlsDir, "s1", "g1"))).toBe(false);
      expect(existsSync(current)).toBe(true);
    });

    it("leaves the files of the stream's next pipeline alone when a run its last one retired comes due", async () => {
      const first = start(120);
      await first.start("http://engine-1/play", false);
      // Two restarts retire its first two runs, with a minute to go; then the stream stops and starts again.
      await first.start("http://engine-2/play", false);
      await first.start("http://engine-3/play", false);
      await first.stop();
      const { due, live } = await startedAgain();
      await aMinutePasses(due);
      expect(existsSync(live)).toBe(true);
    });

    it("leaves them alone too when its last pipeline retired a run only as the stream stopped", async () => {
      const first = start(120);
      await first.start("http://engine-1/play", false);
      await first.start("http://engine-2/play", false);
      // The third run is on its way (it is making its directories) when the stream stops.
      const restarting = first.start("http://engine-3/play", false);
      await first.stop();
      await restarting;
      const { due, live } = await startedAgain();
      await aMinutePasses(due);
      expect(existsSync(live)).toBe(true);
    });

    it("kills the run a restart retired a moment ago when the pipeline stops, as it may still be writing", async () => {
      const instance = start(120);
      await instance.start("http://engine-1/play", false);
      const signals: (NodeJS.Signals | number | undefined)[] = [];
      Object.assign(children[0] ?? {}, {
        kill: (signal?: NodeJS.Signals | number) => {
          signals.push(signal);
          return true;
        },
      });
      await instance.start("http://engine-2/play", false);
      // It was asked to stop, and has three seconds to do so.
      expect(signals).not.toHaveLength(0);
      expect(signals.every((signal) => signal === "SIGTERM")).toBe(true);
      await instance.stop();
      expect(signals.at(-1)).toBe("SIGKILL");
    });
  });
});

describe("Pipeline with a source's live edge", () => {
  let hlsDir: string;
  let pipeline: Pipeline | undefined;
  const children: ChildProcess[] = [];
  /** The live edge each run follows, in order. */
  const edges: { url: string; edge: LiveEdge; stopped: boolean }[] = [];
  const clock = { now: 1_000_000 };

  beforeEach(async () => {
    hlsDir = await mkdtemp(join(tmpdir(), "pipeline-edge-test-"));
    children.length = 0;
    edges.length = 0;
    clock.now = 1_000_000;
  });

  afterEach(async () => {
    await pipeline?.stop();
    await rm(hlsDir, { recursive: true, force: true });
  });

  function start(plan: Partial<PipelineSettings["plan"]> = {}): Pipeline {
    const settings: PipelineSettings = {
      hlsDir,
      ffmpegPath: "ffmpeg",
      handoverTimeoutMs: 120_000,
      plan: {
        previewMode: "video",
        previewHeight: 270,
        previewFps: 15,
        previewBitrateKbps: 400,
        fullTranscodeMaxHeight: 1080,
        audioBitrateKbps: 128,
        segmentSeconds: 2,
        playlistSize: 6,
        thumbnailIntervalSeconds: 10,
        inputTimeoutSeconds: 60,
        ...plan,
      },
      liveEdge: { staleAfterMs: 60_000, noLiveAfterPolls: 10 },
    };
    const events = { generationStarted: () => undefined, handover: () => undefined };
    pipeline = new Pipeline("s1", settings, createLogger("test", "silent"), events, {
      spawner: () => {
        const child = silentProcess();
        children.push(child);
        return child;
      },
      openSource: fakeSources().open,
      now: () => clock.now,
      watchLiveEdge: (url, edge) => {
        const watch = { url, edge, stopped: false };
        edges.push(watch);
        return {
          edge,
          stop: () => {
            watch.stopped = true;
          },
        };
      },
    });
    return pipeline;
  }

  /** What the engine's stats say: its live edge `last`, and how much it downloaded. */
  function stat(run: number, last: number, downloaded: number): void {
    edges[run]?.edge.observe({ status: "dl", downloaded, last, pos: last });
  }

  /** ffmpeg of generation `generation` wrote `count` segments of each of its variants so far. */
  async function wrote(generation: number, count: number, variants = ["full", "preview"]): Promise<void> {
    for (const variant of variants) {
      const directory = join(hlsDir, "s1", `g${String(generation)}`, variant);
      await mkdir(directory, { recursive: true });
      const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:0"];
      for (let index = 0; index < count; index += 1) {
        lines.push("#EXTINF:2.000,", `seg_${String(index).padStart(6, "0")}.ts`);
      }
      await writeFile(join(directory, "index.m3u8"), `${lines.join("\n")}\n`);
    }
  }

  /** An ffmpeg run (the first by default) reports its progress. */
  function frames(frame: number, run = 0): void {
    (children[run]?.stdout as PassThrough).write(`frame=${String(frame)}\nfps=25\nprogress=continue\n`);
  }

  async function playlist(instance: Pipeline): Promise<string[] | undefined> {
    const text = await instance.playlist("full");
    return text?.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
  }

  /** The session's live edge moves a second each second, as a live broadcast's does, and it downloads. */
  function live(run: number, from: number): void {
    for (let step = 0; step <= 3; step += 1) {
      clock.now += step === 0 ? 0 : 1000;
      stat(run, from + step, 100 + step * 100);
    }
  }

  it("publishes a new source only once its live edge moves, and only what it wrote after that", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    expect(edges.map((watch) => watch.url)).toEqual(["http://e1/stat"]);
    // The engine serves what it has, but its live edge has not moved yet.
    stat(0, 5000, 100);
    await wrote(1, 2);
    frames(50);
    await nextTurn();
    expect(await playlist(instance)).toBeUndefined();
    expect(instance.status()).toMatchObject({ state: "running", lastFrameAt: null, liveEdge: { state: "waiting" } });

    // Moving once is not enough: an engine can learn of a later end of an old window once.
    clock.now += 1000;
    stat(0, 5001, 400);
    expect(await playlist(instance)).toBeUndefined();
    clock.now += 1000;
    stat(0, 5002, 450);
    clock.now += 1000;
    stat(0, 5003, 500);
    // What it wrote before its edge was seen to move is not published.
    expect(await playlist(instance)).toBeUndefined();
    frames(100);
    await nextTurn();
    // Its video only counts once players can get some of it.
    expect(instance.status().lastFrameAt).toBeNull();
    await wrote(1, 3);
    expect(await playlist(instance)).toEqual(["../g1/full/seg_000002.ts"]);
    expect(instance.status()).toMatchObject({
      lastFrameAt: new Date(clock.now).toISOString(),
      liveEdge: { state: "live" },
    });
    clock.now += 500;
    frames(110);
    await nextTurn();
    expect(instance.status().lastFrameAt).toBe(new Date(clock.now).toISOString());
  });

  it("publishes a source without a stat URL as before, and counts its video once it has a segment", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    frames(25);
    await nextTurn();
    expect(instance.status().lastFrameAt).toBeNull();
    // A preview segment alone gives players of the full stream nothing.
    const preview = join(hlsDir, "s1", "g1", "preview");
    await mkdir(preview, { recursive: true });
    await writeFile(join(preview, "index.m3u8"), "#EXTM3U\n#EXTINF:2.000,\nseg_000000.ts\n");
    await instance.sync();
    expect(instance.status().lastFrameAt).toBeNull();

    await wrote(1, 2);
    expect(await playlist(instance)).toEqual(["../g1/full/seg_000000.ts", "../g1/full/seg_000001.ts"]);
    expect(instance.status().lastFrameAt).toBe(new Date(clock.now).toISOString());
    expect(edges).toHaveLength(0);
    expect(instance.status().liveEdge).toBeNull();
  });

  it("publishes a source that makes no preview, as with LOW_CPU_PREVIEWS, and has no preview to serve", async () => {
    const instance = start({ previewMode: "thumbnails" });
    await instance.start("http://e1/play", false);
    frames(25);
    await wrote(1, 2, ["full"]);
    expect(await playlist(instance)).toEqual(["../g1/full/seg_000000.ts", "../g1/full/seg_000001.ts"]);
    expect(instance.status().lastFrameAt).toBe(new Date(clock.now).toISOString());
    // The preview's route answers 404 "no segments yet", and the tiles show the thumbnail.
    expect(await instance.playlist("preview")).toBeUndefined();
    const thumbnail = join(hlsDir, "s1", "g1", "thumbnail.jpg");
    await writeFile(thumbnail, "picture");
    await utimes(thumbnail, new Date(clock.now), new Date(clock.now));
    expect(instance.thumbnailPath()).toBe(thumbnail);
  });

  it("stops reading a source whose live edge stops, and drops its segments once they are old", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 5000);
    await instance.sync();
    await wrote(1, 2);
    expect(await playlist(instance)).toEqual(["../g1/full/seg_000000.ts", "../g1/full/seg_000001.ts"]);

    // The broadcast stops: the engine keeps answering, with the same live edge.
    clock.now += 30_000;
    stat(0, 5003, 400);
    await instance.sync();
    expect(children[0]?.killed).toBe(false);
    expect(await playlist(instance)).toHaveLength(2);

    clock.now += 31_000;
    await instance.sync();
    expect(children[0]?.killed).toBe(true);
    // Nothing of it is published from now on, and what was is older than the threshold.
    await wrote(1, 4);
    expect(await playlist(instance)).toBeUndefined();
    expect(instance.status()).toMatchObject({
      liveEdge: { state: "stale" },
      error: "stopped reading: the broadcast's live edge did not move for 60s",
    });

    // Its live edge is still followed: the engine may see the broadcast come back first, which
    // tells the controller to try again now. This one stays stopped.
    expect(edges[0]?.stopped).toBe(false);
    clock.now += 1000;
    stat(0, 5004, 500);
    await instance.sync();
    expect(instance.status().liveEdge).toMatchObject({ state: "live", edgeAt: new Date(5_004_000).toISOString() });
    expect(await playlist(instance)).toBeUndefined();
  });

  it("reports no frame rate once it stopped reading a stale source", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 5000);
    frames(50);
    await nextTurn();
    expect(instance.status().fps).toBe(25);

    clock.now += 61_000;
    await instance.sync();
    expect(children[0]?.killed).toBe(true);
    // ffmpeg may still print its progress while it ends: that is no frame rate to report any more.
    frames(60);
    await nextTurn();
    expect(instance.status()).toMatchObject({ liveEdge: { state: "stale" }, fps: null });
  });

  it("finds a new session that only has the same old window stale at once", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 5000);
    await instance.sync();
    clock.now += 61_000;
    await instance.sync();
    expect(instance.status().liveEdge?.state).toBe("stale");

    // A new session gets the old window from peers that still have it.
    await instance.start("http://e1/play-2", false, 0, "http://e1/stat-2");
    stat(1, 5003, 2_000_000);
    await wrote(2, 3);
    await instance.sync();
    expect(instance.status().liveEdge?.state).toBe("stale");
    expect(children[1]?.killed).toBe(true);
    expect(await playlist(instance)).toBeUndefined();

    // The broadcast is back: the next session's edge is newer than any the stream had, and moves.
    await instance.start("http://e1/play-3", false, 0, "http://e1/stat-3");
    live(2, 5400);
    await instance.sync();
    await wrote(3, 1);
    expect(await playlist(instance)).toEqual(["../g3/full/seg_000000.ts"]);
    expect(instance.status().liveEdge?.state).toBe("live");
  });

  it("does not publish a new session that only knows of a slightly later end of the old window", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 5000);
    await instance.sync();
    clock.now += 61_000;
    await instance.sync();

    // Another engine had a few more seconds of the window, and it serves them: its edge is newer
    // than the stream's and it downloads, but the edge never moves again.
    await instance.start("http://e2/play", false, 0, "http://e2/stat");
    stat(1, 5006, 100);
    for (let poll = 1; poll <= 61; poll += 1) {
      clock.now += 1000;
      stat(1, 5006, 100 + poll * 10_000);
      await instance.sync();
      if (poll === 30) {
        await wrote(2, 3);
      }
      expect(await playlist(instance)).toBeUndefined();
    }
    expect(instance.status()).toMatchObject({ lastFrameAt: null, liveEdge: { state: "stale" } });
  });

  it("goes on counting how long the broadcast sent nothing new through retries on slightly newer windows", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 5000);
    const lastNewData = clock.now;
    await instance.sync();
    expect(instance.status().liveEdge).toMatchObject({ state: "live", quietSince: iso(lastNewData) });

    // The broadcast stopped. Ten minutes later another engine knows of a few more seconds of the
    // old window than the stream's session did, and its edge never moves again.
    clock.now += 600_000;
    await instance.start("http://e2/play", false, 0, "http://e2/stat");
    // Before the new session has a live position of its own, it already says since when.
    expect(instance.status().liveEdge).toMatchObject({
      state: "waiting",
      edgeAt: null,
      advancedAt: null,
      quietSince: iso(lastNewData),
    });
    stat(1, 5006, 100);
    clock.now += 61_000;
    await instance.sync();
    expect(instance.status().liveEdge).toMatchObject({
      state: "stale",
      advancedAt: iso(clock.now - 61_000),
      quietSince: iso(lastNewData),
    });

    // The next retry starts from that one, and still counts from the last new data.
    await instance.start("http://e3/play", false, 0, "http://e3/stat");
    stat(2, 5008, 100);
    clock.now += 61_000;
    await instance.sync();
    expect(instance.status().liveEdge).toMatchObject({ state: "stale", quietSince: iso(lastNewData) });
  });

  it("counts the quiet time from the last time any session of the stream was live, whichever had the newest edge", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 9000);
    // The next session is far behind it, as after the broadcaster's clock jumped back, and moves on its own.
    clock.now += 100_000;
    await instance.start("http://e2/play", false, 0, "http://e2/stat");
    live(1, 5000);
    const lastNewData = clock.now;

    // The first session has the newest edge, but the second one was live later. A retry on a
    // slightly newer window than the second one's starts from both.
    clock.now += 100_000;
    await instance.start("http://e3/play", false, 0, "http://e3/stat");
    stat(2, 5006, 100);
    clock.now += 61_000;
    await instance.sync();
    expect(instance.status().liveEdge).toMatchObject({ state: "stale", quietSince: iso(lastNewData) });
  });

  it("knows that the broadcast goes on from the last session that saw new data, whichever had the newest edge", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 9000);
    // The next session is far behind it, as after the broadcaster's clock jumped back, and moves on its own.
    clock.now += 100_000;
    await instance.start("http://e2/play", false, 0, "http://e2/stat");
    live(1, 5000);

    // Ten seconds later a new engine serves 103 s behind the edge. The first session has the
    // newest edge, and saw new data long ago, but the second one's is what says the broadcast goes on.
    clock.now += 10_000;
    await instance.start("http://e3/play", false, 0, "http://e3/stat");
    edges[2]?.edge.observe({ status: "dl", downloaded: 100, last: 5020, pos: 4917 });
    await instance.sync();
    expect(instance.status().liveEdge).toMatchObject({ state: "stale", staleBecause: "behind", behindSeconds: 103 });
  });

  it("does not hand over to a source whose live edge does not move, and gives up once it is stale", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 5000);
    await wrote(1, 1);
    await instance.sync();

    await instance.start("http://e2/play", true, 0, "http://e2/stat");
    stat(1, 4990, 1_000_000);
    await wrote(2, 3);
    for (let step = 0; step < 6; step += 1) {
      clock.now += 10_000;
      stat(0, 5004 + step * 10, 500 + step);
      await instance.sync();
    }
    expect(instance.status()).toMatchObject({ source: "http://e1/play", pendingSource: "http://e2/play" });

    clock.now += 1;
    stat(0, 5100, 500);
    await instance.sync();
    expect(instance.status()).toMatchObject({ source: "http://e1/play", pendingSource: null });
    expect(children[1]?.killed).toBe(true);
  });

  it("hands over once the new source's live edge moves and it wrote a segment since", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    live(0, 5000);
    await instance.sync();
    await wrote(1, 2);
    await instance.sync();

    await instance.start("http://e2/play", true, 0, "http://e2/stat");
    stat(1, 5003, 100);
    await wrote(2, 1);
    for (const last of [5004, 5005, 5006]) {
      clock.now += 1000;
      stat(1, last, last - 4900);
    }
    await instance.sync();
    expect(instance.status().pendingSource).toBe("http://e2/play");
    frames(40, 1);
    await nextTurn();
    await wrote(2, 2);
    await instance.sync();
    // The controller's handover waits for video from the new source: it counts at once.
    expect(instance.status()).toMatchObject({
      source: "http://e2/play",
      pendingSource: null,
      lastFrameAt: new Date(clock.now).toISOString(),
    });
    expect(await playlist(instance)).toEqual([
      "../g1/full/seg_000000.ts",
      "../g1/full/seg_000001.ts",
      "../g2/full/seg_000001.ts",
    ]);
  });

  it("only shows a thumbnail written while the source's output is published, and only while recent", async () => {
    const instance = start();
    await instance.start("http://e1/play", false, 0, "http://e1/stat");
    const thumbnail = join(hlsDir, "s1", "g1", "thumbnail.jpg");
    await mkdir(join(hlsDir, "s1", "g1"), { recursive: true });
    await writeFile(thumbnail, "old window");
    await utimes(thumbnail, new Date(clock.now), new Date(clock.now));
    stat(0, 5000, 100);
    expect(instance.thumbnailPath()).toBeUndefined();

    for (const last of [5001, 5002, 5003]) {
      clock.now += 1000;
      stat(0, last, last - 4900);
    }
    await instance.sync();
    expect(instance.thumbnailPath()).toBeUndefined();
    clock.now += 1000;
    await utimes(thumbnail, new Date(clock.now), new Date(clock.now));
    expect(instance.thumbnailPath()).toBe(thumbnail);

    // The source goes stale; its ffmpeg writes one more picture as it stops, which is no newer.
    clock.now += 61_000;
    await instance.sync();
    expect(children[0]?.killed).toBe(true);
    await utimes(thumbnail, new Date(clock.now), new Date(clock.now));
    expect(instance.thumbnailPath()).toBeUndefined();
  });
});
