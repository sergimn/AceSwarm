import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Generation } from "../src/generation.ts";
import { MEMORY_SETTLES_MS, processMemory, StuckRuns, type MemoryReader, type Stuck } from "../src/stuck-runs.ts";

const MB = 1024 * 1024;

/** A run of ffmpeg writing to `directory`, with a process of that pid. */
function run(directory: string, pid?: number, mode: "copy" | "transcode" = "copy"): Generation {
  const generation = new Generation({
    number: 1,
    source: "http://engine/play",
    directory,
    mode,
    allFrames: false,
    startedAt: 0,
    inputTimeoutSeconds: 60,
  });
  generation.process = pid === undefined ? undefined : ({ pid } as ChildProcess);
  generation.state = "running";
  return generation;
}

const huge = (): number => 10_000 * MB;

describe("StuckRuns", () => {
  let directory: string;
  let generation: Generation;
  /** The clock `StuckRuns` goes by, in ms. */
  const clock = { now: 0 };
  /** The modification time the next write gets, in seconds: any time will do, as long as it changes. */
  let mark = 1_800_000_000;

  function runs(stallSeconds = 30, growthMb = 512, memoryOf: MemoryReader = () => 100 * MB): StuckRuns {
    const limits = { fullOutputStallMs: stallSeconds * 1000, maxMemoryGrowthBytes: growthMb * MB };
    return new StuckRuns(limits, 10, { memoryOf, now: () => clock.now });
  }

  beforeEach(async () => {
    clock.now = 0;
    directory = await mkdtemp(join(tmpdir(), "stuck-runs-test-"));
    await mkdir(join(directory, "full"));
    await mkdir(join(directory, "preview"));
    generation = run(directory, 4242);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** ffmpeg writes a file of the run in `at` (its directory). */
  async function wrote(file: string, at = directory): Promise<void> {
    const path = join(at, file);
    await writeFile(path, "x");
    mark += 1;
    await utimes(path, mark, mark);
  }

  const fullSegment = (at = directory): Promise<void> => wrote("full/index.m3u8", at);
  const previewSegment = (at = directory): Promise<void> => wrote("preview/index.m3u8", at);

  /** Seconds pass by the clock of `StuckRuns`. */
  function after(seconds: number): void {
    clock.now += seconds * 1000;
  }

  /**
   * `count` checks, `every` seconds apart, each once the run of `of` made what `make` writes: none
   * may find it stuck but the last, and what that one found is returned.
   */
  async function play(
    watch: StuckRuns,
    count: number,
    every: number,
    make: () => Promise<void>,
    of = generation,
  ): Promise<Stuck | undefined> {
    for (let check = 1; check < count; check += 1) {
      after(every);
      await make();
      expect(watch.check(of)).toBeUndefined();
    }
    after(every);
    await make();
    return watch.check(of);
  }

  /**
   * The first run plays, then its full output stalls for the stall time: it is started again. Its
   * preview writes every `every` seconds, which has to divide the stall time and be no more than the
   * pause limit (15 s): a longer gap counts as a pause of the source, and the stall time starts again.
   */
  async function firstStalls(watch: StuckRuns, stallSeconds = 30, every = 2): Promise<void> {
    await fullSegment();
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    expect((await play(watch, stallSeconds / every, every, previewSegment))?.reencode).toBe(false);
  }

  it("leaves a run alone while its full output keeps writing segments", async () => {
    const watch = runs();
    for (let second = 0; second <= 120; second += 2) {
      await fullSegment();
      await previewSegment();
      generation.frames = second * 25;
      expect(watch.check(generation)).toBeUndefined();
      after(2);
    }
  });

  it("finds a run whose full output stopped while its preview goes on", async () => {
    const watch = runs();
    await fullSegment();
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    for (let second = 2; second <= 28; second += 2) {
      after(2);
      await previewSegment();
      expect(watch.check(generation)).toBeUndefined();
    }
    after(2);
    await previewSegment();
    expect(watch.check(generation)).toEqual({
      reason: "full-output-stalled",
      reencode: false,
      message: "the full output wrote no segment while ffmpeg still made video; starting it again",
      details: { seconds: 30, frames: 0 },
    });
  });

  it("goes by ffmpeg's frame count too, and by the thumbnail, so that it works without a preview", async () => {
    const watch = runs();
    await fullSegment();
    generation.frames = 25;
    expect(watch.check(generation)).toBeUndefined();
    const counted = async (): Promise<void> => {
      generation.frames += 25;
      await Promise.resolve();
    };
    expect((await play(watch, 30, 1, counted))?.details).toEqual({ seconds: 30, frames: 775 });

    // A thumbnail every 10 s, its interval, and nothing else: no pause of the source.
    const thumbnails = runs();
    const other = run(directory, 4243);
    await wrote("thumbnail.jpg");
    expect(thumbnails.check(other)).toBeUndefined();
    expect((await play(thumbnails, 3, 10, () => wrote("thumbnail.jpg"), other))?.reason).toBe("full-output-stalled");
  });

  it("leaves a run alone that makes no video at all: its source stopped, which the controller handles", async () => {
    const watch = runs();
    await fullSegment();
    await previewSegment();
    generation.frames = 25;
    expect(watch.check(generation)).toBeUndefined();
    // Nothing more is written for minutes: whatever the clock says, ffmpeg made no video since.
    for (let second = 0; second < 300; second += 1) {
      after(1);
      expect(watch.check(generation)).toBeUndefined();
    }
  });

  it("counts from when the run first made video, not from when it started", async () => {
    const watch = runs();
    // A slow engine: the first data comes long after ffmpeg started, and the full output's first
    // segment needs a key frame more than the preview's.
    after(60);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    expect(await play(watch, 11, 2, previewSegment)).toBeUndefined();
    after(1);
    await fullSegment();
    expect(watch.check(generation)).toBeUndefined();
    expect(await play(watch, 14, 2, previewSegment)).toBeUndefined();
  });

  it("finds a run whose full output never wrote a segment while its preview went on", async () => {
    const watch = runs();
    after(5);
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    expect((await play(watch, 15, 2, previewSegment))?.details).toEqual({ seconds: 30, frames: 0 });
  });

  it("counts a run with no full segment yet from its first frame: its copy can start no earlier", async () => {
    const watch = runs();
    // The decoder shows pictures from an I frame that a copy can't start at: ffmpeg counts no frame
    // until the next key frame, 20 s on, and the full output's first segment ends at the one after.
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    expect(await play(watch, 10, 2, previewSegment)).toBeUndefined();
    const counted = async (): Promise<void> => {
      generation.frames += 50;
      await previewSegment();
    };
    expect(await play(watch, 12, 2, counted)).toBeUndefined();
    after(1);
    await fullSegment();
    expect(watch.check(generation)).toBeUndefined();

    // Without that segment, it is stuck the stall time after its first frame.
    const late = runs();
    const lateDirectory = await mkdtemp(join(tmpdir(), "stuck-runs-late-"));
    await mkdir(join(lateDirectory, "preview"));
    const other = run(lateDirectory, 4243);
    const preview = (): Promise<void> => previewSegment(lateDirectory);
    await preview();
    expect(late.check(other)).toBeUndefined();
    expect(await play(late, 10, 2, preview, other)).toBeUndefined();
    const frames = async (): Promise<void> => {
      other.frames += 50;
      await preview();
    };
    expect((await play(late, 16, 2, frames, other))?.details).toEqual({ seconds: 30, frames: 800 });
    await rm(lateDirectory, { recursive: true, force: true });
  });

  it("leaves a pause of the source out: the full output writes on once it is back", async () => {
    const watch = runs();
    for (let second = 0; second <= 20; second += 2) {
      await fullSegment();
      await previewSegment();
      generation.frames = second * 25;
      expect(watch.check(generation)).toBeUndefined();
      after(2);
    }
    // Nothing for 35 s: more than the 10 s between thumbnails, and then some.
    for (let second = 0; second < 35; second += 1) {
      after(1);
      expect(watch.check(generation)).toBeUndefined();
    }
    // Back: its first frames come before its next key frame, which the full output's segment ends at.
    const counted = async (): Promise<void> => {
      generation.frames += 25;
      await previewSegment();
    };
    expect(await play(watch, 3, 1, counted)).toBeUndefined();
    await fullSegment();
    expect(watch.check(generation)).toBeUndefined();

    // Its full output stops later on: that is found, the stall time after its last segment.
    expect((await play(watch, 30, 1, counted))?.reason).toBe("full-output-stalled");
  });

  it("uses the stall time it is given", async () => {
    const watch = runs(10);
    await fullSegment();
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    after(9);
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    after(1);
    await previewSegment();
    expect(watch.check(generation)?.reason).toBe("full-output-stalled");
  });

  it("goes by its own clock: when the files say they were written makes no difference", async () => {
    const watch = runs();
    // The system's clock steps an hour on between a full segment and a preview segment: the
    // preview's file looks an hour newer, while two seconds pass each time.
    for (let second = 0; second <= 60; second += 2) {
      await fullSegment();
      mark += second === 30 ? 3600 : 0;
      await previewSegment();
      expect(watch.check(generation)).toBeUndefined();
      after(2);
    }
  });

  it("finds a run whose memory grew by more than allowed over what it settled at, whatever its outputs do", async () => {
    let memory = 1100 * MB;
    const watch = runs(30, 512, (pid) => (pid === 4242 ? memory : undefined));
    for (let second = 0; second <= 120; second += 2) {
      await fullSegment();
      await previewSegment();
      expect(watch.check(generation)).toBeUndefined();
      after(2);
    }
    memory = 1612 * MB;
    expect(watch.check(generation)).toBeUndefined();
    memory = 1613 * MB;
    expect(watch.check(generation)).toEqual({
      reason: "memory",
      reencode: false,
      message: "ffmpeg's memory keeps growing; starting it again",
      details: { memoryMb: 1613, settledMb: 1100, limitMb: 512 },
    });
  });

  it("takes what a run holds a minute after its first video as what it needs, however much that is", async () => {
    // A re-encode on a host with many cores holds over a GB from its first seconds on.
    let memory = 300 * MB;
    const watch = runs(30, 512, () => memory);
    after(10);
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    for (let second = 0; second < MEMORY_SETTLES_MS / 1000; second += 2) {
      memory += 50 * MB;
      after(2);
      await fullSegment();
      await previewSegment();
      expect(watch.check(generation)).toBeUndefined();
    }
    // Settled at 1800 MB: that much more is fine for good. Both outputs write every 10 s from here
    // on, as often as a run makes a thumbnail: nothing in it is a stall (30 s) or a pause (15 s).
    // Steps of 2 s would make 1200 real file system calls, which a slow disk may not get through
    // within the test's time.
    for (let second = 0; second < 600; second += 10) {
      after(10);
      await fullSegment();
      await previewSegment();
      expect(watch.check(generation)).toBeUndefined();
    }
  });

  it("reads no memory before a run's first video: ffmpeg sets up its encoders once data comes", async () => {
    // While ffmpeg waits for the engine it holds little; once video comes, its encoders take more,
    // within seconds. The wait is longer than the minute it settles in: that minute counts from
    // the first video, not from the run's first check.
    let memory = 20 * MB;
    const watch = runs(30, 512, () => memory);
    for (let second = 0; second < MEMORY_SETTLES_MS / 1000 + 20; second += 2) {
      expect(watch.check(generation)).toBeUndefined();
      after(2);
    }
    for (let second = 0; second <= 120; second += 2) {
      memory = (second < 10 ? 20 : 700) * MB;
      await fullSegment();
      await previewSegment();
      expect(watch.check(generation)).toBeUndefined();
      after(2);
    }
  });

  it("has no memory limit at 0, and none when the memory can't be read", async () => {
    for (const watch of [runs(30, 0, huge), runs(30, 512, () => undefined)]) {
      await previewSegment();
      await fullSegment();
      expect(watch.check(generation)).toBeUndefined();
      after(120);
      await previewSegment();
      await fullSegment();
      expect(watch.check(generation)).toBeUndefined();
    }
  });

  it("leaves runs alone that ended, were replaced, stopped for a stale source or have no process", async () => {
    const exited = run(directory, 1);
    exited.state = "exited";
    const retired = run(directory, 2);
    retired.retired = true;
    const stale = run(directory, 3);
    stale.staleStopped = true;
    const none = run(directory);
    for (const ended of [exited, retired, stale, none]) {
      let memory = 100 * MB;
      const watch = runs(30, 512, () => memory);
      // Its preview goes on long after its last full segment, and its memory grows.
      await fullSegment();
      await previewSegment();
      expect(watch.check(ended)).toBeUndefined();
      after(90);
      memory = huge();
      await previewSegment();
      expect(watch.check(ended)).toBeUndefined();
    }
  });

  it("checks a run that has made no frame yet too, as ffmpeg counts the frames of the full output", async () => {
    const watch = runs();
    generation.state = "starting";
    await previewSegment();
    expect(watch.check(generation)).toBeUndefined();
    expect((await play(watch, 15, 2, previewSegment))?.reason).toBe("full-output-stalled");
  });

  describe("when the run that replaced a stalled one stalls too", () => {
    let next: Generation;
    let nextDirectory: string;

    beforeEach(async () => {
      nextDirectory = await mkdtemp(join(tmpdir(), "stuck-runs-next-"));
      await mkdir(join(nextDirectory, "full"));
      await mkdir(join(nextDirectory, "preview"));
      next = run(nextDirectory, 4343);
      next.state = "starting";
    });

    afterEach(async () => {
      await rm(nextDirectory, { recursive: true, force: true });
    });

    const nextPreview = (): Promise<void> => previewSegment(nextDirectory);

    /**
     * The new run makes previews from 5 s on, every `every` seconds (as for `firstStalls`), but its
     * copy gets no frame: no key frame comes.
     */
    async function nextStalls(watch: StuckRuns, stallSeconds = 30, every = 2): Promise<Stuck | undefined> {
      after(5);
      await nextPreview();
      expect(watch.check(next)).toBeUndefined();
      return play(watch, stallSeconds / every, every, nextPreview, next);
    }

    it("re-encodes the full stream when its copy never wrote a segment", async () => {
      const watch = runs();
      await firstStalls(watch);
      expect(await nextStalls(watch)).toEqual({
        reason: "full-output-stalled",
        reencode: true,
        message:
          "the full output wrote no segment again after a restart: the copied video has no key frames to cut it at; re-encoding it",
        details: { seconds: 30, frames: 0 },
      });
    });

    it("re-encodes with a long stall time too: the new run has that long, and 5 minutes more", async () => {
      // Every 10 s, as often as a run makes a thumbnail: steps of 2 s over 10 minutes would make 600
      // real file system calls, which a slow disk may not get through within the test's time.
      const watch = runs(300);
      await firstStalls(watch, 300, 10);
      expect((await nextStalls(watch, 300, 10))?.reencode).toBe(true);
    });

    it("starts a copy again when the new run had full segments before it stalled", async () => {
      const watch = runs();
      await firstStalls(watch);
      after(5);
      await nextPreview();
      after(2);
      await fullSegment(nextDirectory);
      expect(watch.check(next)).toBeUndefined();
      expect((await play(watch, 15, 2, nextPreview, next))?.reencode).toBe(false);
    });

    it("starts a copy again once a later run wrote a full segment, whatever stalls after", async () => {
      const watch = runs();
      await firstStalls(watch);
      // The new run plays: the copy can be cut after all. Another one replaces it (a new source,
      // say), and its copy gets nothing.
      after(5);
      await nextPreview();
      await fullSegment(nextDirectory);
      expect(watch.check(next)).toBeUndefined();
      const third = run(directory, 4545);
      await rm(join(directory, "full", "index.m3u8"));
      after(5);
      await previewSegment();
      expect(watch.check(third)).toBeUndefined();
      expect((await play(watch, 15, 2, previewSegment, third))?.reencode).toBe(false);
    });

    it("starts a copy again when the new run stalls long after", async () => {
      // Its first video comes so late that it is found stalled a second after the stall time and
      // the 5 minutes; with a second less, it re-encodes.
      for (const [late, reencode] of [
        [5 * 60, true],
        [5 * 60 + 1, false],
      ] as const) {
        const watch = runs();
        await firstStalls(watch);
        after(late);
        await nextPreview();
        expect(watch.check(next)).toBeUndefined();
        expect((await play(watch, 15, 2, nextPreview, next))?.reencode).toBe(reencode);
      }
    });

    it("never re-encodes for a run that re-encodes already, nor after a run whose memory grew", async () => {
      let memory = 100 * MB;
      const watch = runs(30, 512, () => memory);
      for (let second = 0; second <= 70; second += 2) {
        await fullSegment();
        await previewSegment();
        expect(watch.check(generation)).toBeUndefined();
        after(2);
      }
      memory = 2000 * MB;
      expect(watch.check(generation)?.reason).toBe("memory");
      memory = 100 * MB;
      expect((await nextStalls(watch))?.reencode).toBe(false);

      const transcoding = run(nextDirectory, 4444, "transcode");
      after(5);
      await nextPreview();
      expect(watch.check(transcoding)).toBeUndefined();
      expect((await play(watch, 15, 2, nextPreview, transcoding))?.reencode).toBe(false);
    });
  });
});

describe("processMemory", () => {
  it("reads a process's resident and swapped-out memory on Linux", () => {
    if (process.platform !== "linux") {
      expect(processMemory(process.pid)).toBeUndefined();
      return;
    }
    const memory = processMemory(process.pid) ?? 0;
    expect(memory).toBeGreaterThan(10 * MB);
    expect(memory).toBeLessThan(process.memoryUsage().rss * 2 + 100 * MB);
  });

  it("knows nothing of a process that doesn't exist", () => {
    expect(processMemory(2 ** 30)).toBeUndefined();
  });
});
