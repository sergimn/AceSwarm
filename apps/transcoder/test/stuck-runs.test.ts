import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Generation } from "../src/generation.ts";
import { processMemory, StuckRuns, type MemoryReader } from "../src/stuck-runs.ts";

const START = 1_800_000_000_000;
const MB = 1024 * 1024;

/** A run of ffmpeg writing to `directory`, with a process of that pid. */
function run(directory: string, pid?: number): Generation {
  const generation = new Generation({
    number: 1,
    source: "http://engine/play",
    directory,
    mode: "copy",
    allFrames: false,
    startedAt: START,
    inputTimeoutSeconds: 60,
  });
  generation.process = pid === undefined ? undefined : ({ pid } as ChildProcess);
  generation.state = "running";
  return generation;
}

function runs(stallSeconds = 30, maxMemoryMb = 1024, memoryOf: MemoryReader = () => 100 * MB): StuckRuns {
  return new StuckRuns({ fullOutputStallMs: stallSeconds * 1000, maxMemoryBytes: maxMemoryMb * MB }, memoryOf);
}

const huge = (): number => 10_000 * MB;

describe("StuckRuns", () => {
  let directory: string;
  let generation: Generation;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "stuck-runs-test-"));
    await mkdir(join(directory, "full"));
    await mkdir(join(directory, "preview"));
    generation = run(directory, 4242);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** ffmpeg writes a file of the run at `at` (ms), as its modification time says. */
  async function wrote(file: string, at: number): Promise<void> {
    const path = join(directory, file);
    await writeFile(path, "x");
    await utimes(path, at / 1000, at / 1000);
  }

  const fullSegment = (at: number): Promise<void> => wrote("full/index.m3u8", at);
  const previewSegment = (at: number): Promise<void> => wrote("preview/index.m3u8", at);

  /** The first run plays, then its full output stalls for 30 s: it is started again. */
  async function firstStalls(watch: StuckRuns): Promise<number> {
    await fullSegment(START);
    await previewSegment(START);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment(START + 30_000);
    expect(watch.check(generation)?.reencode).toBe(false);
    return START + 30_000;
  }

  it("leaves a run alone while its full output keeps writing segments", async () => {
    const watch = runs();
    for (let second = 0; second <= 120; second += 2) {
      await fullSegment(START + second * 1000);
      await previewSegment(START + second * 1000);
      generation.lastFrameAt = START + second * 1000;
      expect(watch.check(generation)).toBeUndefined();
    }
  });

  it("finds a run whose full output stopped while its preview goes on", async () => {
    const watch = runs();
    await fullSegment(START);
    await previewSegment(START);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment(START + 28_000);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment(START + 30_000);
    expect(watch.check(generation)).toEqual({
      reason: "full-output-stalled",
      reencode: false,
      message: "the full output wrote no segment while ffmpeg still made video; starting it again",
      details: { seconds: 30, frames: 0 },
    });
  });

  it("goes by ffmpeg's frame count too, and by the thumbnail, so that it works without a preview", async () => {
    const watch = runs();
    await fullSegment(START);
    generation.lastFrameAt = START;
    expect(watch.check(generation)).toBeUndefined();
    generation.frames = 1500;
    generation.lastFrameAt = START + 31_000;
    expect(watch.check(generation)?.details).toEqual({ seconds: 31, frames: 1500 });

    const thumbnails = runs();
    const other = run(directory, 4243);
    await wrote("thumbnail.jpg", START);
    await fullSegment(START);
    expect(thumbnails.check(other)).toBeUndefined();
    await wrote("thumbnail.jpg", START + 40_000);
    expect(thumbnails.check(other)?.reason).toBe("full-output-stalled");
  });

  it("leaves a run alone that makes no video at all: its source stopped, which the controller handles", async () => {
    const watch = runs();
    await fullSegment(START);
    await previewSegment(START);
    generation.lastFrameAt = START;
    // Nothing more is written for minutes: whatever the clock says, ffmpeg made no video since.
    expect(watch.check(generation)).toBeUndefined();
    expect(watch.check(generation)).toBeUndefined();
  });

  it("counts from when the run first made video, not from when it started", async () => {
    const watch = runs();
    // A slow engine: the first data comes long after ffmpeg started, and the full output's first
    // segment needs a key frame more than the preview's.
    await previewSegment(START + 60_000);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment(START + 80_000);
    expect(watch.check(generation)).toBeUndefined();
    await fullSegment(START + 82_000);
    await previewSegment(START + 100_000);
    expect(watch.check(generation)).toBeUndefined();
  });

  it("finds a run whose full output never wrote a segment while its preview went on", async () => {
    const watch = runs();
    await previewSegment(START + 5000);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment(START + 35_000);
    expect(watch.check(generation)?.details).toEqual({ seconds: 30, frames: 0 });
  });

  it("uses the stall time it is given", async () => {
    const watch = runs(10);
    await fullSegment(START);
    await previewSegment(START);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment(START + 9000);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment(START + 10_000);
    expect(watch.check(generation)?.reason).toBe("full-output-stalled");
  });

  it("finds a run that holds more memory than allowed, whatever its outputs do", async () => {
    let memory = 900 * MB;
    const watch = runs(30, 1024, (pid) => (pid === 4242 ? memory : undefined));
    await fullSegment(START);
    await previewSegment(START);
    expect(watch.check(generation)).toBeUndefined();
    memory = 1025 * MB;
    expect(watch.check(generation)).toEqual({
      reason: "memory",
      reencode: false,
      message: "ffmpeg holds too much memory; starting it again",
      details: { memoryMb: 1025, limitMb: 1024 },
    });
  });

  it("has no memory limit at 0, and none when the memory can't be read", async () => {
    await previewSegment(START);
    await fullSegment(START);
    expect(runs(30, 0, () => 10_000 * MB).check(generation)).toBeUndefined();
    expect(runs(30, 1024, () => undefined).check(generation)).toBeUndefined();
  });

  it("leaves runs alone that ended, were replaced, stopped for a stale source or have no process", async () => {
    await fullSegment(START);
    await previewSegment(START + 60_000);
    const exited = run(directory, 1);
    exited.state = "exited";
    const retired = run(directory, 2);
    retired.retired = true;
    const stale = run(directory, 3);
    stale.staleStopped = true;
    const none = run(directory);
    for (const ended of [exited, retired, stale, none]) {
      const watch = runs(30, 1024, huge);
      // Its preview went on long after its last full segment.
      await previewSegment(START);
      expect(watch.check(ended)).toBeUndefined();
      await previewSegment(START + 60_000);
      expect(watch.check(ended)).toBeUndefined();
    }
  });

  it("checks a run that has made no frame yet too, as ffmpeg counts the frames of the full output", async () => {
    const watch = runs();
    generation.state = "starting";
    await previewSegment(START);
    expect(watch.check(generation)).toBeUndefined();
    await previewSegment(START + 30_000);
    expect(watch.check(generation)?.reason).toBe("full-output-stalled");
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

    async function nextWrote(file: string, at: number): Promise<void> {
      const path = join(nextDirectory, file);
      await writeFile(path, "x");
      await utimes(path, at / 1000, at / 1000);
    }

    it("re-encodes the full stream when its copy never wrote a segment", async () => {
      const watch = runs();
      const stalledAt = await firstStalls(watch);
      // The new run makes previews from 5 s on, but the copy gets no frame: no key frame comes.
      await nextWrote("preview/index.m3u8", stalledAt + 5000);
      expect(watch.check(next)).toBeUndefined();
      await nextWrote("preview/index.m3u8", stalledAt + 35_000);
      expect(watch.check(next)).toEqual({
        reason: "full-output-stalled",
        reencode: true,
        message:
          "the full output wrote no segment again after a restart: the copied video has no key frames to cut it at; re-encoding it",
        details: { seconds: 30, frames: 0 },
      });
    });

    it("starts a copy again when the new run had full segments before it stalled", async () => {
      const watch = runs();
      const stalledAt = await firstStalls(watch);
      await nextWrote("preview/index.m3u8", stalledAt + 5000);
      await nextWrote("full/index.m3u8", stalledAt + 7000);
      expect(watch.check(next)).toBeUndefined();
      await nextWrote("preview/index.m3u8", stalledAt + 37_000);
      expect(watch.check(next)?.reencode).toBe(false);
    });

    it("starts a copy again when the new run stalls long after", async () => {
      const watch = runs();
      const stalledAt = await firstStalls(watch);
      await nextWrote("preview/index.m3u8", stalledAt + 5 * 60_000 - 30_000);
      expect(watch.check(next)).toBeUndefined();
      await nextWrote("preview/index.m3u8", stalledAt + 5 * 60_000 + 1);
      expect(watch.check(next)?.reencode).toBe(false);
    });

    it("never re-encodes for a run that re-encodes already, nor after a run that held too much memory", async () => {
      let memory = 2000 * MB;
      const watch = runs(30, 1024, () => memory);
      await previewSegment(START);
      expect(watch.check(generation)?.reason).toBe("memory");
      memory = 100 * MB;
      await nextWrote("preview/index.m3u8", START + 5000);
      expect(watch.check(next)).toBeUndefined();
      await nextWrote("preview/index.m3u8", START + 35_000);
      expect(watch.check(next)?.reencode).toBe(false);

      const transcoding = new Generation({
        number: 3,
        source: "http://engine/play",
        directory: nextDirectory,
        mode: "transcode",
        allFrames: false,
        startedAt: START,
        inputTimeoutSeconds: 60,
      });
      transcoding.process = { pid: 4444 } as ChildProcess;
      await nextWrote("preview/index.m3u8", START + 40_000);
      expect(watch.check(transcoding)).toBeUndefined();
      await nextWrote("preview/index.m3u8", START + 70_000);
      expect(watch.check(transcoding)?.reencode).toBe(false);
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
