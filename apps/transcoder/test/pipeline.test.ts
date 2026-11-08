import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createLogger } from "@aceswarm/shared/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEdge } from "../src/live-edge.ts";
import { Pipeline, type PipelineSettings } from "../src/pipeline.ts";

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

/** The source an ffmpeg run reads. */
function sourceOf(args: string[] | undefined): string | undefined {
  const index = args?.indexOf("-i") ?? -1;
  return index === -1 ? undefined : args?.[index + 1];
}

/** How long an ffmpeg run waits for its input, in microseconds. */
function inputTimeout(args: string[] | undefined): string | undefined {
  const index = args?.indexOf("-rw_timeout") ?? -1;
  return index === -1 ? undefined : args?.[index + 1];
}

describe("Pipeline", () => {
  let hlsDir: string;
  let pipeline: Pipeline | undefined;
  /** The arguments of every ffmpeg run, in order. */
  const runs: string[][] = [];
  /** Every ffmpeg process, in the same order. */
  const children: ChildProcess[] = [];

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
    pipeline = new Pipeline("s1", settings, logger, events, {
      spawner: (_command, args) => {
        runs.push(args);
        const child = silentProcess();
        children.push(child);
        return child;
      },
      now,
    });
    return pipeline;
  }

  it("waits the usual input timeout for a source it starts without a handover", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-1/play-again", false);
    expect(runs.map((args) => inputTimeout(args))).toEqual(["60000000", "60000000"]);
  });

  it("waits as long as the handover for a new engine's first data", async () => {
    const instance = start(120);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(runs[1])).toBe("120000000");
    expect(instance.status().pendingSource).toBe("http://engine-2/play");
  });

  it("waits as long as the handover even when there is no picture left to keep", async () => {
    const instance = start(120);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(runs[0])).toBe("120000000");
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
    expect(inputTimeout(runs[2])).toBe("120000000");
    expect(instance.status().pendingSource).toBe("http://engine-2/play");
  });

  it("keeps the usual input timeout when the handover timeout is shorter", async () => {
    const instance = start(30);
    await instance.start("http://engine-1/play", false);
    await instance.start("http://engine-2/play", true);
    expect(inputTimeout(runs[1])).toBe("60000000");
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
      expect(sourceOf(runs[run])).toBe("http://engine-2/play");
      expect(inputTimeout(runs[run])).toBe("120000000");
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
    expect(sourceOf(runs[2])).toBe("http://engine-2/play");
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
    expect(running.map((child) => sourceOf(runs[children.indexOf(child)]))).toEqual(["http://engine-2/play"]);
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

  function start(): Pipeline {
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

  /** ffmpeg of generation `generation` wrote `count` segments of each variant so far. */
  async function wrote(generation: number, count: number): Promise<void> {
    for (const variant of ["full", "preview"]) {
      const directory = join(hlsDir, "s1", `g${String(generation)}`, variant);
      await mkdir(directory, { recursive: true });
      const lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-MEDIA-SEQUENCE:0"];
      for (let index = 0; index < count; index += 1) {
        lines.push("#EXTINF:2.000,", `seg_${String(index).padStart(6, "0")}.ts`);
      }
      await writeFile(join(directory, "index.m3u8"), `${lines.join("\n")}\n`);
    }
  }

  /** The first ffmpeg run reports its progress. */
  function frames(frame: number): void {
    (children[0]?.stdout as PassThrough).write(`frame=${String(frame)}\nfps=25\nprogress=continue\n`);
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

  it("publishes a source without a stat URL as before", async () => {
    const instance = start();
    await instance.start("http://e1/play", false);
    await wrote(1, 2);
    expect(await playlist(instance)).toEqual(["../g1/full/seg_000000.ts", "../g1/full/seg_000001.ts"]);
    expect(edges).toHaveLength(0);
    expect(instance.status().liveEdge).toBeNull();
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
    await wrote(2, 2);
    await instance.sync();
    expect(instance.status()).toMatchObject({ source: "http://e2/play", pendingSource: null });
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
