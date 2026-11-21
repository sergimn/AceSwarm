import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, constants, openSync, rmSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { createLogger, type Logger } from "@aceswarm/shared/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pipeline, type PipelineSettings } from "../src/pipeline.ts";
import { fakeSources, layoutOf, type FakeSource } from "./fake-source.ts";

const HEVC = 0x24;
/** A stream type the tables give no codec for (private data, without a descriptor that names it). */
const UNNAMED = 0x06;

/** A fake ffmpeg, and whether it was signalled while its input was still open. */
type FakeChild = ChildProcess & { signalledWhileReading: boolean };

/**
 * An ffmpeg process that takes its input and says nothing by itself. The real one reads its input
 * from a pipe, and while it waits there for more it acts on no signal: a stop must end the input
 * first, or ffmpeg stays until it is killed three seconds later.
 */
/** The text of a run's playlist with `count` segments. */
const playlistOf = (count: number): string =>
  [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-MEDIA-SEQUENCE:0",
    ...Array.from({ length: count }, (_, index) => `#EXTINF:2.000,\nseg_${String(index).padStart(6, "0")}.ts`),
    "",
  ].join("\n");

function quietProcess(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const stdin = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    signalledWhileReading: false,
    kill: () => {
      // Once is enough: a later signal after its input ended does not take the first one back.
      Object.assign(child, {
        killed: true,
        signalledWhileReading: child.signalledWhileReading || !stdin.writableEnded,
      });
      return true;
    },
  });
  return child;
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe("Pipeline following what its source carries", () => {
  let hlsDir: string;
  let pipeline: Pipeline | undefined;
  /** The arguments of every ffmpeg run, in order, and the processes. */
  const runs: string[][] = [];
  const children: FakeChild[] = [];
  /** Why each ffmpeg run started, in the same order. */
  const reasons: string[] = [];
  const handovers: string[] = [];
  /** Every connection to a source, in order: a run that takes over mid-stream opens none. */
  let opened: FakeSource[] = [];
  /** How to end each read that a test made wait (see `holdPlaylist`). */
  const heldOpen: (() => void)[] = [];
  const clock = { now: 1_000_000 };

  beforeEach(async () => {
    hlsDir = await mkdtemp(join(tmpdir(), "pipeline-layout-test-"));
    runs.length = 0;
    children.length = 0;
    reasons.length = 0;
    handovers.length = 0;
    clock.now = 1_000_000;
  });

  afterEach(async () => {
    // A read that still waits on a pipe (see `holdPlaylist`) ends here, whatever its test did.
    for (const end of heldOpen.splice(0)) {
      end();
    }
    await pipeline?.stop();
    vi.useRealTimers();
    await rm(hlsDir, { recursive: true, force: true });
    // Whatever a test did, no ffmpeg was left waiting for input with only a signal to end it.
    expect(children.map((child) => child.signalledWhileReading)).toEqual(children.map(() => false));
  });

  function start(logger = createLogger("test", "silent")): Pipeline {
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
        playlistSize: 8,
        thumbnailIntervalSeconds: 10,
        inputTimeoutSeconds: 60,
      },
    };
    const events = {
      generationStarted: (_id: string, reason: string) => {
        reasons.push(reason);
      },
      handover: (_id: string, result: string) => {
        handovers.push(result);
      },
    };
    const sources = fakeSources();
    opened = sources.opened;
    pipeline = new Pipeline("s1", settings, logger, events, {
      spawner: (_command, args) => {
        runs.push(args);
        const child = quietProcess();
        children.push(child);
        return child;
      },
      now: () => clock.now,
      openSource: sources.open,
    });
    return pipeline;
  }

  /** What a run's ffmpeg does with the full output's video. */
  const modeOf = (run: number): string => (runs[run]?.includes("copy") === true ? "copy" : "transcode");
  /** How long a run's ffmpeg studies its input before it starts, in seconds. */
  const analyzes = (run: number): number => {
    const args = runs[run] ?? [];
    return Number(args[args.indexOf("-analyzeduration") + 1]) / 1_000_000;
  };
  const inputEnded = (run: number): boolean => (children[run]?.stdin as PassThrough).writableEnded;
  const killed = (run: number): boolean => children[run]?.killed === true;

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

  /**
   * Makes the playlist of the first run's full output a named pipe, so that the pipeline's next read
   * of it waits: what happens to the run meanwhile is up to the test. `reading` settles once that read
   * waits, `aside` puts the pipe out of the way of later reads (the one that waits keeps it), and
   * `end` lets the read end with a playlist of `count` segments. The pipeline's own timer must not
   * read the pipe too: such a test fakes `setInterval` before it starts its pipeline. A test that
   * fails on the way leaves nothing waiting: `reading` gives up after four seconds, and the end of
   * every test ends a read that waits on the pipe, whether the test got to open it or not.
   */
  function holdPlaylist(): {
    reading: () => Promise<void>;
    aside: () => void;
    end: (count: number) => void;
  } {
    const path = join(hlsDir, "s1", "g1", "full", "index.m3u8");
    rmSync(path);
    execFileSync("mkfifo", [path]);
    let writer: number | undefined;
    /** Opens the pipe for writing, which fails until a reader has it open (or once it is out of the way). */
    const open = (): boolean => {
      try {
        writer ??= openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch {
        // No read waits on it.
      }
      return writer !== undefined;
    };
    const close = (): void => {
      // A read that waits on the pipe ends when its writer closes it: one that no writer opened yet too.
      if (!open() || writer === undefined) {
        return;
      }
      closeSync(writer);
      writer = undefined;
    };
    heldOpen.push(close);
    return {
      reading: async () => {
        const giveUpAt = Date.now() + 4000;
        while (!open()) {
          if (Date.now() > giveUpAt) {
            throw new Error("the pipeline did not read the playlist");
          }
          await sleep(2);
        }
      },
      aside: () => {
        rmSync(path);
      },
      end: (count) => {
        writeSync(writer ?? -1, playlistOf(count));
        close();
      },
    };
  }

  async function frames(frame: number, run: number): Promise<void> {
    (children[run]?.stdout as PassThrough).write(`frame=${String(frame)}\nfps=25\nprogress=continue\n`);
    await nextTurn();
  }

  /** ffmpeg's banner names the video of its input. */
  async function banner(run: number, codec: string): Promise<void> {
    (children[run]?.stderr as PassThrough).write(
      `Input #0, mpegts, from 'pipe:0':\n  Stream #0:0[0x100]: Video: ${codec} (Main), yuv420p, 1920x1080\n`,
    );
    await nextTurn();
  }

  function exit(run: number, code = 0): void {
    Object.assign(children[run] ?? {}, { exitCode: code });
    children[run]?.emit("exit", code, null);
  }

  /** The segments players get of the full output, in order. */
  async function playlist(instance: Pipeline): Promise<string[]> {
    const text = (await instance.playlist("full")) ?? "";
    return text
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.replace("../", "").replace("/full/seg_00000", ":").replace(".ts", ""));
  }

  /** A stream that plays: its first run published three segments, its last frame at the clock's time. */
  async function playing(): Promise<Pipeline> {
    const instance = start();
    await instance.start("http://e1/play", false);
    opened[0]?.layout(layoutOf(256));
    await wrote(1, 3);
    await frames(75, 0);
    expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2"]);
    await frames(100, 0);
    return instance;
  }

  describe("the full output's mode", () => {
    it("replaces a run in the wrong mode once the source's tables name its video, on the same connection", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      expect(modeOf(0)).toBe("copy");
      expect(analyzes(0)).toBe(5);

      // The tables come before ffmpeg got a byte.
      expect(opened[0]?.layout(layoutOf(256, HEVC))).toBe(true);
      expect(runs).toHaveLength(2);
      expect(modeOf(1)).toBe("transcode");
      expect(reasons).toEqual(["start", "transcode"]);
      // The first run read nothing and is gone; the source is read on as it is, for the new one.
      expect(killed(0)).toBe(true);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.stopped).toBe(false);
      // Nothing of the stream was read yet, so the new run studies it like any other.
      expect(analyzes(1)).toBe(5);
      expect(instance.status()).toMatchObject({
        state: "starting",
        mode: "transcode",
        videoCodec: "hevc",
        layout: "program 1 [256:hevc 257:0x0f]",
        layoutChangedAt: null,
        source: "http://e1/play",
      });

      // What the reader passes on goes to the new run.
      await opened[0]?.sink.write(Uint8Array.of(1, 2, 3));
      expect((children[1]?.stdin as PassThrough).read()).toEqual(Buffer.of(1, 2, 3));
      expect((children[0]?.stdin as PassThrough).read()).toBeNull();
    });

    it("leaves a run as it is when the tables name the video it was started for", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      expect(opened[0]?.layout(layoutOf(256))).toBe(false);
      expect(runs).toHaveLength(1);
      expect(instance.status()).toMatchObject({
        mode: "copy",
        videoCodec: "h264",
        layout: "program 1 [256:h264 257:0x0f]",
      });
    });

    it("starts the next run in the mode the stream's last video needed, and goes back when that changed", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      opened[0]?.layout(layoutOf(256, HEVC));
      expect(runs.map((_, run) => modeOf(run))).toEqual(["copy", "transcode"]);

      // Most sources stay as they are: another engine's session of the stream starts re-encoding.
      await instance.start("http://e2/play", false);
      expect(modeOf(2)).toBe("transcode");
      expect(opened[1]?.layout(layoutOf(256, HEVC))).toBe(false);
      expect(runs).toHaveLength(3);

      // The broadcast is H.264 again by the time the next source starts: it is copied again.
      await instance.start("http://e3/play", false);
      expect(modeOf(3)).toBe("transcode");
      expect(opened[2]?.layout(layoutOf(256))).toBe(true);
      expect(modeOf(4)).toBe("copy");
      expect(opened).toHaveLength(3);
      expect(instance.status()).toMatchObject({ mode: "copy", videoCodec: "h264" });
      await instance.start("http://e4/play", false);
      expect(modeOf(5)).toBe("copy");
    });

    it("forgets the playing source's change when another source is started in its place", async () => {
      const instance = await playing();
      clock.now += 5000;
      expect(opened[0]?.layout(layoutOf(211))).toBe(true);
      expect(instance.status()).toMatchObject({ layoutChangedAt: iso(clock.now) });
      // As the controller does for a stream that doesn't play: no handover, the new source takes its place.
      await instance.start("http://e2/play", false);
      expect(instance.status()).toMatchObject({ source: "http://e2/play", layoutChangedAt: null });
    });

    it("publishes nothing of a run that was replaced while its segments were looked up", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const instance = await playing();
      const held = holdPlaylist();
      const syncing = instance.sync();
      await held.reading();
      // Another source takes the stream while the run's playlist is still being read.
      await instance.start("http://e2/play", false);
      held.end(5);
      await syncing;
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2"]);
    });

    it("publishes nothing of a run whose time to write out ended while its segments were looked up", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const instance = await playing();
      expect(opened[0]?.layout(layoutOf(211, HEVC))).toBe(true);
      const held = holdPlaylist();
      const syncing = instance.sync();
      await held.reading();
      // Meanwhile the run's time is up, and another sync (for a player's request) is done with it.
      held.aside();
      await wrote(1, 3);
      clock.now += 3000;
      await instance.sync();
      held.end(5);
      await syncing;
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2"]);
    });

    it("follows ffmpeg's own finding where the tables don't tell, in both directions", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      expect(opened[0]?.layout(layoutOf(256, UNNAMED))).toBe(false);
      expect(instance.status()).toMatchObject({ mode: "copy", videoCodec: null });

      await banner(0, "hevc");
      await vi.waitFor(() => {
        expect(runs).toHaveLength(2);
      });
      expect(modeOf(1)).toBe("transcode");
      expect(reasons).toEqual(["start", "transcode"]);
      // ffmpeg had the stream's start by then, so the new run reads the source again.
      expect(opened).toHaveLength(2);
      expect(opened[0]?.stopped).toBe(true);
      expect(killed(0)).toBe(true);

      // The run that re-encodes lists its own H.264 output after its input: that is not the source's video.
      await banner(1, "hevc");
      (children[1]?.stderr as PassThrough).write(
        "Stream mapping:\n  Stream #0:0 -> #0:0 (hevc (native) -> h264 (libx264))\n" +
          "Output #0, hls, to 'full/index.m3u8':\n  Stream #0:0: Video: h264, yuv420p, 1920x1080\n",
      );
      await nextTurn();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toHaveLength(2);
      expect(instance.status()).toMatchObject({ mode: "transcode", videoCodec: "hevc" });

      // A later source of the stream carries H.264: its run starts re-encoding, and is replaced by one that copies.
      await instance.start("http://e2/play", false);
      expect(modeOf(2)).toBe("transcode");
      await banner(2, "h264");
      await vi.waitFor(() => {
        expect(runs).toHaveLength(4);
      });
      expect(modeOf(3)).toBe("copy");
      expect(reasons.at(-1)).toBe("copy");
      expect(opened.map((source) => source.request.source)).toEqual([
        "http://e1/play",
        "http://e1/play",
        "http://e2/play",
        "http://e2/play",
      ]);
      await banner(3, "h264");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toHaveLength(4);
      expect(instance.status()).toMatchObject({ mode: "copy", videoCodec: "h264" });
    });
  });

  describe("a source whose tables and ffmpeg disagree", () => {
    it("takes ffmpeg's finding for that layout from then on, and does not go back and forth", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      // The tables say H.264, so the run copies; ffmpeg finds HEVC in the stream it takes for the video.
      expect(opened[0]?.layout(layoutOf(256))).toBe(false);
      await banner(0, "hevc");
      await vi.waitFor(() => {
        expect(runs).toHaveLength(2);
      });
      expect(modeOf(1)).toBe("transcode");
      expect(opened).toHaveLength(2);

      // The new run reads the same tables: they don't send it back to copying.
      expect(opened[1]?.layout(layoutOf(256))).toBe(false);
      await banner(1, "hevc");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toHaveLength(2);
      expect(instance.status()).toMatchObject({ mode: "transcode", videoCodec: "hevc" });

      // Nor a later source of the stream with that layout.
      await instance.start("http://e2/play", false);
      expect(modeOf(2)).toBe("transcode");
      expect(opened[2]?.layout(layoutOf(256))).toBe(false);
      expect(runs).toHaveLength(3);

      // Another layout is taken at its word, until ffmpeg says otherwise about it too.
      expect(opened[2]?.layout(layoutOf(211))).toBe(true);
      expect(modeOf(3)).toBe("copy");
      await banner(3, "h264");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toHaveLength(4);
      // And back on the first layout, ffmpeg's finding still stands.
      expect(opened[2]?.layout(layoutOf(256))).toBe(true);
      expect(modeOf(4)).toBe("transcode");
      expect(opened).toHaveLength(3);
    });

    it("lets ffmpeg change its finding for a layout", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      opened[0]?.layout(layoutOf(256));
      await banner(0, "hevc");
      await vi.waitFor(() => {
        expect(runs).toHaveLength(2);
      });
      opened[1]?.layout(layoutOf(256));
      // This time ffmpeg agrees with the tables: the next run copies, and stays.
      await banner(1, "h264");
      await vi.waitFor(() => {
        expect(runs).toHaveLength(3);
      });
      expect(modeOf(2)).toBe("copy");
      expect(opened[2]?.layout(layoutOf(256))).toBe(false);
      await banner(2, "h264");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toHaveLength(3);
      expect(instance.status()).toMatchObject({ mode: "copy", videoCodec: "h264" });
    });
  });

  describe("a layout change mid-stream", () => {
    it("starts a new run on the same connection, and publishes the old run's last segments first", async () => {
      const instance = await playing();
      const lastFrame = clock.now;
      expect(instance.status()).toMatchObject({ state: "running", lastFrameAt: iso(lastFrame), layoutChangedAt: null });

      // The video moves to other PIDs.
      clock.now += 5000;
      expect(opened[0]?.layout(layoutOf(211))).toBe(true);
      expect(runs).toHaveLength(2);
      expect(reasons).toEqual(["start", "layout"]);
      expect(modeOf(1)).toBe("copy");
      // It knows the stream from the tables in front of it: it need not study it for long.
      expect(analyzes(1)).toBe(1);
      // The engine's session is read on. The old run's input ended at the change; it is not stopped.
      expect(opened).toHaveLength(1);
      expect(opened[0]?.stopped).toBe(false);
      expect(inputEnded(0)).toBe(true);
      expect(killed(0)).toBe(false);
      expect(inputEnded(1)).toBe(false);
      // Until the new run has video out, the stream's last frame is the old run's.
      expect(instance.status()).toMatchObject({
        state: "starting",
        mode: "copy",
        layout: "program 1 [211:h264 212:0x0f]",
        layoutChangedAt: iso(clock.now),
        lastFrameAt: iso(lastFrame),
        frames: 0,
        source: "http://e1/play",
      });

      // The new run has a segment before the old one wrote its last: a playlist only goes forward, so it waits.
      clock.now += 1000;
      await wrote(2, 1);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2"]);
      await wrote(1, 4);
      exit(0);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g1:3", "g2:0"]);
      // The old run's end is not the source's: the new run reads on.
      expect(opened[0]?.stopped).toBe(false);
      // Players have a segment of the new run, but ffmpeg has counted no frame of it yet: a
      // segment alone is no video (sound fills one too), so the last frame is the old run's.
      expect(instance.status()).toMatchObject({ state: "starting", lastFrameAt: iso(lastFrame) });

      clock.now += 2000;
      await frames(40, 1);
      await wrote(2, 2);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g1:3", "g2:0", "g2:1"]);
      expect(instance.status()).toMatchObject({ state: "running", lastFrameAt: iso(clock.now), frames: 40 });
    });

    it("counts the frames the old run still writes out as the stream's, until the new run has its own", async () => {
      const instance = await playing();
      clock.now += 5000;
      opened[0]?.layout(layoutOf(211));
      // The old run's input ended: it reports the frames it still had, and writes its last segment.
      clock.now += 400;
      await frames(112, 0);
      const written = clock.now;
      await wrote(1, 4);
      clock.now += 300;
      await instance.sync();
      expect(instance.status()).toMatchObject({ state: "starting", frames: 0, lastFrameAt: iso(written) });

      clock.now += 2000;
      await frames(30, 1);
      expect(instance.status()).toMatchObject({ state: "running", frames: 30, lastFrameAt: iso(written) });
      // The new run's frames count once players can get them.
      exit(0);
      await wrote(2, 1);
      await instance.sync();
      expect(instance.status()).toMatchObject({ lastFrameAt: iso(clock.now) });
    });

    it("takes a change for a sign of video only after a run that had video of its own", async () => {
      const instance = await playing();
      const lastFrame = clock.now;
      clock.now += 5000;
      opened[0]?.layout(layoutOf(211));
      const first = clock.now;
      expect(instance.status()).toMatchObject({ layoutChangedAt: iso(first) });

      // The video is gone, and the tables keep changing: every run ends without a frame.
      for (const pid of [256, 211, 256]) {
        clock.now += 3000;
        expect(opened[0]?.layout(layoutOf(pid))).toBe(true);
        expect(instance.status()).toMatchObject({ layoutChangedAt: iso(first), lastFrameAt: iso(lastFrame) });
      }
      expect(reasons).toEqual(["start", "layout", "layout", "layout", "layout"]);
      // Sound alone fills segments: they are published, and are no video either.
      await wrote(5, 2);
      for (const run of [0, 1, 2, 3]) {
        exit(run);
      }
      await instance.sync();
      expect((await playlist(instance)).slice(-2)).toEqual(["g5:0", "g5:1"]);
      expect(instance.status()).toMatchObject({ layoutChangedAt: iso(first), lastFrameAt: iso(lastFrame), frames: 0 });

      // Once a run shows video again, the next change counts from its own time.
      clock.now += 2000;
      await frames(25, 4);
      clock.now += 4000;
      expect(opened[0]?.layout(layoutOf(211))).toBe(true);
      expect(instance.status()).toMatchObject({ layoutChangedAt: iso(clock.now) });
    });

    it("starts the run the new video needs", async () => {
      const instance = await playing();
      expect(opened[0]?.layout(layoutOf(211, HEVC))).toBe(true);
      expect(modeOf(1)).toBe("transcode");
      expect(analyzes(1)).toBe(1);
      expect(instance.status()).toMatchObject({ mode: "transcode", videoCodec: "hevc" });
      // And back.
      expect(opened[0]?.layout(layoutOf(256))).toBe(true);
      expect(modeOf(2)).toBe("copy");
      expect(reasons).toEqual(["start", "layout", "layout"]);
      expect(opened).toHaveLength(1);
      expect(inputEnded(1)).toBe(true);

      // Both runs that handed over end with what they had; each one's output comes in its turn.
      await wrote(3, 1);
      await wrote(2, 1);
      exit(1);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2"]);
      await wrote(1, 4);
      exit(0);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g1:3", "g2:0", "g3:0"]);
    });

    it("keeps the mode when the new tables don't name the video's codec", async () => {
      const instance = await playing();
      const lastFrame = clock.now;
      clock.now += 2000;
      expect(opened[0]?.layout(layoutOf(211, UNNAMED))).toBe(true);
      expect(modeOf(1)).toBe("copy");
      expect(instance.status()).toMatchObject({ mode: "copy", videoCodec: null });
      // ffmpeg finds out, and a run in the other mode reads the source again.
      clock.now += 1000;
      await banner(1, "vp9");
      await vi.waitFor(() => {
        expect(runs).toHaveLength(3);
      });
      expect(modeOf(2)).toBe("transcode");
      expect(opened).toHaveLength(2);
      // The stream showed video until the change: its new run is no stream that never played.
      expect(instance.status()).toMatchObject({ state: "starting", lastFrameAt: iso(lastFrame) });
      // Its first segment is out before ffmpeg reports a frame: the last frame is still the old one.
      exit(0);
      await wrote(3, 1);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g3:0"]);
      expect(instance.status()).toMatchObject({ lastFrameAt: iso(lastFrame) });
      clock.now += 3000;
      await frames(25, 2);
      expect(instance.status()).toMatchObject({ state: "running", lastFrameAt: iso(clock.now) });
    });

    it("waits three seconds at most for the old run's last segments", async () => {
      const instance = await playing();
      opened[0]?.layout(layoutOf(211));
      await wrote(2, 1);
      clock.now += 2900;
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2"]);
      expect(killed(0)).toBe(false);
      clock.now += 100;
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g2:0"]);
      expect(killed(0)).toBe(true);
      // What it writes after that is too late.
      await wrote(1, 4);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g2:0"]);
    });

    it("goes on with a handover whose new source changes its layout before it took over", async () => {
      const instance = await playing();
      await instance.start("http://e2/play", true);
      expect(instance.status()).toMatchObject({ source: "http://e1/play", pendingSource: "http://e2/play" });
      opened[1]?.layout(layoutOf(256));
      // It has video of its own by the time it changes.
      await frames(50, 1);
      clock.now += 30_000;
      expect(opened[1]?.layout(layoutOf(211, HEVC))).toBe(true);
      expect(runs).toHaveLength(3);
      expect(modeOf(2)).toBe("transcode");
      // Nothing of the waiting source was published, so its first run is not waited for.
      expect(killed(1)).toBe(true);
      expect(opened[1]?.stopped).toBe(false);
      // The source players get did not change: its video is not excused for this.
      expect(instance.status()).toMatchObject({
        source: "http://e1/play",
        pendingSource: "http://e2/play",
        layout: "program 1 [256:h264 257:0x0f]",
        layoutChangedAt: null,
      });

      await wrote(3, 1);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g3:0"]);
      expect(handovers).toEqual(["promoted"]);
      expect(instance.status()).toMatchObject({ source: "http://e2/play", pendingSource: null, mode: "transcode" });
      expect(opened[0]?.stopped).toBe(true);
    });

    it("publishes a source that took over after the playing one got a new run meanwhile", async () => {
      const instance = await playing();
      await instance.start("http://e2/play", true);
      // The waiting source has the new layout from its start; then the playing one reaches the change.
      opened[1]?.layout(layoutOf(211));
      clock.now += 3000;
      expect(opened[0]?.layout(layoutOf(211))).toBe(true);
      expect(reasons).toEqual(["start", "handover", "layout"]);
      expect(instance.status()).toMatchObject({ source: "http://e1/play", layoutChangedAt: iso(clock.now) });
      // The playing source's new run has the highest number, and publishes first.
      exit(0);
      await wrote(3, 1);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g3:0"]);

      // The source that waited takes over: its segments come next, whatever its run's number.
      clock.now += 2000;
      await frames(50, 1);
      const shown = clock.now;
      await wrote(2, 2);
      await instance.sync();
      expect(handovers).toEqual(["promoted"]);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g3:0", "g2:0", "g2:1"]);
      // Players get a source that never changed its layout: the other one's change is not about it.
      expect(instance.status()).toMatchObject({
        state: "running",
        source: "http://e2/play",
        lastFrameAt: iso(shown),
        layoutChangedAt: null,
      });
      // The run it took over from wrote more meanwhile: that is not the stream's any more.
      await wrote(3, 2);
      await wrote(2, 3);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g3:0", "g2:0", "g2:1", "g2:2"]);
    });

    it("gives the handover its whole time, counted from its start, whatever its source's layout does", async () => {
      const instance = await playing();
      await instance.start("http://e2/play", true);
      opened[1]?.layout(layoutOf(256));
      clock.now += 100_000;
      opened[1]?.layout(layoutOf(211));
      clock.now += 19_000;
      await instance.sync();
      expect(handovers).toEqual([]);
      clock.now += 2000;
      await instance.sync();
      expect(handovers).toEqual(["failed"]);
      expect(instance.status()).toMatchObject({ source: "http://e1/play", pendingSource: null });
      expect(opened[1]?.stopped).toBe(true);
    });

    it("takes no notice of a source that is no longer the stream's", async () => {
      const instance = await playing();
      await instance.start("http://e2/play", false);
      expect(opened[0]?.stopped).toBe(true);
      expect(opened[0]?.layout(layoutOf(211, HEVC))).toBe(false);
      expect(runs).toHaveLength(2);
      expect(instance.status()).toMatchObject({ mode: "copy", layoutChangedAt: null });
    });
  });

  describe("streams that move to other PIDs mid-stream", () => {
    it("lets the same run read on, and tells when the stream changed", async () => {
      const instance = await playing();
      const lastFrame = clock.now;
      clock.now += 5000;
      opened[0]?.move(layoutOf(211));
      expect(runs).toHaveLength(1);
      expect(reasons).toEqual(["start"]);
      expect(inputEnded(0)).toBe(false);
      expect(killed(0)).toBe(false);
      // Players wait a moment for the picture the stream goes on from: the controller allows for that.
      expect(instance.status()).toMatchObject({
        state: "running",
        mode: "copy",
        videoCodec: "h264",
        layout: "program 1 [211:h264 212:0x0f]",
        layoutChangedAt: iso(clock.now),
        lastFrameAt: iso(lastFrame),
        frames: 100,
      });

      // The run publishes on as before.
      await wrote(1, 4);
      expect(await playlist(instance)).toEqual(["g1:0", "g1:1", "g1:2", "g1:3"]);
      // A change the run can't read on over starts a new one from the layout the stream has now.
      clock.now += 5000;
      expect(opened[0]?.layout(layoutOf(311, HEVC))).toBe(true);
      expect(reasons).toEqual(["start", "layout"]);
      expect(modeOf(1)).toBe("transcode");
      expect(instance.status()).toMatchObject({ layoutChangedAt: iso(clock.now) });
    });

    it("takes a change of the tables alone for no change of the stream", async () => {
      const instance = await playing();
      clock.now += 5000;
      // The program's table is on another PID; the streams are where they were.
      opened[0]?.move(layoutOf(256, 0x1b, 4097), true);
      expect(runs).toHaveLength(1);
      expect(instance.status()).toMatchObject({ state: "running", layoutChangedAt: null });
    });

    it("logs tables that keep changing over the same streams once a minute", async () => {
      const lines: string[] = [];
      const note =
        (level: string) =>
        (_fields: object, text: string): void => {
          lines.push(`${level}: ${text.split(",", 1)[0] ?? ""}`);
        };
      const logger = { info: note("info"), debug: note("debug"), warn: note("warn"), error: note("error") };
      const instance = start({ ...logger, child: () => logger } as unknown as Logger);
      await instance.start("http://e1/play", false);
      opened[0]?.layout(layoutOf(256));
      lines.length = 0;
      const inPlace = "the broadcast changed its tables";
      for (const [wait, pmtPid] of [
        [5000, 4097],
        [1000, 4096],
        [58_999, 4097],
        [1, 4096],
      ] as const) {
        clock.now += wait;
        opened[0]?.move(layoutOf(256, 0x1b, pmtPid), true);
      }
      expect(lines).toEqual([`info: ${inPlace}`, `debug: ${inPlace}`, `debug: ${inPlace}`, `info: ${inPlace}`]);
      // A move is told every time.
      opened[0]?.move(layoutOf(211));
      opened[0]?.move(layoutOf(256));
      const moved = "info: the broadcast moved its streams to other PIDs; the same ffmpeg run reads on";
      expect(lines.slice(4)).toEqual([moved, moved]);
      expect(runs).toHaveLength(1);
    });

    it("takes a move for a sign of video only on the source players get, after it had video", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      opened[0]?.layout(layoutOf(256));
      // No frame of the run yet.
      clock.now += 5000;
      opened[0]?.move(layoutOf(211));
      expect(instance.status()).toMatchObject({ state: "starting", layoutChangedAt: null });
      await wrote(1, 3);
      await frames(75, 0);

      // A source that waits to take over moves its streams: players don't get that one.
      await instance.start("http://e2/play", true);
      opened[1]?.layout(layoutOf(256));
      await frames(50, 1);
      clock.now += 5000;
      opened[1]?.move(layoutOf(211));
      expect(runs).toHaveLength(2);
      expect(instance.status()).toMatchObject({ pendingSource: "http://e2/play", layoutChangedAt: null });

      clock.now += 1000;
      opened[0]?.move(layoutOf(256));
      const told = iso(clock.now);
      expect(instance.status()).toMatchObject({ layoutChangedAt: told });

      // Moves that keep coming while the run shows no new frame are no sign of video: a stream
      // that stalled over them must not look alive for as long as they come.
      clock.now += 15_000;
      opened[0]?.move(layoutOf(211));
      clock.now += 15_000;
      opened[0]?.move(layoutOf(256));
      expect(instance.status()).toMatchObject({ layoutChangedAt: told, frames: 75 });
      await frames(76, 0);
      clock.now += 1000;
      opened[0]?.move(layoutOf(211));
      expect(instance.status()).toMatchObject({ layoutChangedAt: iso(clock.now) });
    });

    it("keeps what ffmpeg found the video to be, on the PIDs it moved to", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      // The tables say H.264; ffmpeg finds HEVC, and a run that re-encodes reads the source again.
      opened[0]?.layout(layoutOf(256));
      await banner(0, "hevc");
      await vi.waitFor(() => {
        expect(runs).toHaveLength(2);
      });
      opened[1]?.layout(layoutOf(256));
      await banner(1, "hevc");
      opened[1]?.move(layoutOf(211));
      expect(runs).toHaveLength(2);
      expect(instance.status()).toMatchObject({ mode: "transcode", videoCodec: "hevc" });

      // A later source that starts on the new PIDs is not sent back to copying for what its tables say.
      await instance.start("http://e2/play", false);
      expect(modeOf(2)).toBe("transcode");
      expect(opened[2]?.layout(layoutOf(211))).toBe(false);
      expect(runs).toHaveLength(3);
      // On PIDs ffmpeg said nothing about, the tables are taken at their word.
      expect(opened[2]?.layout(layoutOf(311))).toBe(true);
      expect(modeOf(3)).toBe("copy");
    });

    it("takes no notice of a source that is no longer the stream's", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      opened[0]?.layout(layoutOf(256));
      await banner(0, "hevc");
      await vi.waitFor(() => {
        expect(runs).toHaveLength(2);
      });
      opened[1]?.layout(layoutOf(256));
      await banner(1, "hevc");
      await instance.start("http://e2/play", false);
      expect(opened[1]?.stopped).toBe(true);
      opened[2]?.layout(layoutOf(256));
      // What the old source's reader still tells is not the stream's: neither its layout, nor where ffmpeg's finding holds.
      opened[1]?.move(layoutOf(211));
      expect(instance.status()).toMatchObject({ layout: "program 1 [256:h264 257:0x0f]", layoutChangedAt: null });
      expect(opened[2]?.layout(layoutOf(211))).toBe(true);
      expect(modeOf(3)).toBe("copy");
    });
  });

  describe("the end of a source", () => {
    it("lets ffmpeg write out what it has, and says why the stream ended", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      opened[0]?.layout(layoutOf(256));
      await frames(50, 0);
      opened[0]?.end("the engine ended the stream");
      expect(inputEnded(0)).toBe(true);
      expect(killed(0)).toBe(false);
      expect(instance.status()).toMatchObject({ state: "running" });
      exit(0);
      expect(instance.status()).toMatchObject({ state: "exited", exitCode: 0, error: "the engine ended the stream" });
    });

    it("stops an ffmpeg that does not end by itself five seconds after its source did", async () => {
      vi.useFakeTimers();
      const instance = start();
      await instance.start("http://e1/play", false);
      opened[0]?.end("no data from the engine for 60s");
      await vi.advanceTimersByTimeAsync(4900);
      expect(killed(0)).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(killed(0)).toBe(true);
      expect(instance.status().error).toBe("no data from the engine for 60s");
    });

    it("stops reading a source whose ffmpeg ended, and every source when the stream stops", async () => {
      const instance = start();
      await instance.start("http://e1/play", false);
      (children[0]?.stderr as PassThrough).write("Conversion failed!\n");
      await nextTurn();
      exit(0, 1);
      expect(opened[0]?.stopped).toBe(true);
      expect(instance.status()).toMatchObject({ state: "exited", exitCode: 1, error: "Conversion failed!" });

      await instance.start("http://e2/play", false);
      await instance.start("http://e3/play", true);
      opened[1]?.layout(layoutOf(256));
      opened[1]?.layout(layoutOf(211));
      await instance.stop();
      expect(opened.map((source) => source.stopped)).toEqual([true, true, true]);
      expect(children.map((child) => child.killed)).toEqual([false, true, true, true]);
    });

    it("ends the input of a run it replaces before it signals its ffmpeg", async () => {
      const instance = await playing();
      // Another source takes the stream at once: the first run is no longer needed.
      await instance.start("http://e2/play", false);
      expect(opened[0]?.stopped).toBe(true);
      expect(killed(0)).toBe(true);
      expect(inputEnded(0)).toBe(true);
      expect(children[0]?.signalledWhileReading).toBe(false);
      // The run that took its place reads on.
      expect(inputEnded(1)).toBe(false);
      expect(killed(1)).toBe(false);
    });

    it("ends the input of every ffmpeg it stops, which acts on no signal while it waits for input", async () => {
      const instance = await playing();
      // A source waits to take over, and the stream stops: both runs are stopped.
      await instance.start("http://e2/play", true);
      expect(children.map((_child, run) => inputEnded(run))).toEqual([false, false]);
      await instance.stop();
      expect(children.map((child) => child.killed)).toEqual([true, true]);
      expect(children.map((_child, run) => inputEnded(run))).toEqual([true, true]);
      expect(children.map((child) => child.signalledWhileReading)).toEqual([false, false]);
    });
  });
});
