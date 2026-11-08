import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createDecodeChecker, DEFAULT_DECODE_CHECK_SETTINGS, type DecodeCheckSettings } from "../src/decode-check.ts";

interface FakeFfmpeg {
  child: ChildProcess;
  args: string[];
  stdin: PassThrough;
  stdout: PassThrough;
  received: () => number;
  killed: () => boolean;
}

/** ffmpeg processes that do what each test tells them. */
function fakeSpawner() {
  const runs: FakeFfmpeg[] = [];
  const spawner = (_command: string, args: string[]): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let received = 0;
    let killed = false;
    stdin.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    Object.assign(child, {
      stdin,
      stdout,
      kill: () => {
        killed = true;
        return true;
      },
    });
    runs.push({ child, args, stdin, stdout, received: () => received, killed: () => killed });
    return child;
  };
  return { spawner, runs };
}

const settings: DecodeCheckSettings = { ...DEFAULT_DECODE_CHECK_SETTINGS, minFrames: 5, timeoutMs: 5000 };

describe("createDecodeChecker", () => {
  test("has ffmpeg decode the first video stream of MPEG-TS from stdin, and passes once enough frames came", async () => {
    const ffmpeg = fakeSpawner();
    const check = createDecodeChecker(settings, ffmpeg.spawner).start();
    const run = ffmpeg.runs[0];
    expect(run?.args.join(" ")).toContain("-f mpegts -i pipe:0 -map 0:v:0 -f null");
    expect(run?.args.join(" ")).toContain("-progress pipe:1");

    check?.feed(new Uint8Array(1000));
    await new Promise((resolve) => setImmediate(resolve));
    expect(run?.received()).toBe(1000);

    run?.stdout.write("frame=2\nprogress=continue\n");
    run?.stdout.write("frame=5\nprogress=continue\n");
    expect(await check?.result).toBe(true);
    expect(run?.killed()).toBe(true);
  });

  test("fails when no video comes in time", async () => {
    const ffmpeg = fakeSpawner();
    const check = createDecodeChecker({ ...settings, timeoutMs: 20 }, ffmpeg.spawner).start();
    ffmpeg.runs[0]?.stdout.write("frame=0\nprogress=continue\n");
    expect(await check?.result).toBe(false);
    expect(ffmpeg.runs[0]?.killed()).toBe(true);
  });

  test("fails when ffmpeg exits or can't start", async () => {
    const ffmpeg = fakeSpawner();
    const checker = createDecodeChecker(settings, ffmpeg.spawner);
    const exits = checker.start();
    ffmpeg.runs[0]?.child.emit("exit", 1, null);
    expect(await exits?.result).toBe(false);

    const fails = checker.start();
    ffmpeg.runs[1]?.child.emit("error", new Error("spawn ffmpeg ENOENT"));
    expect(await fails?.result).toBe(false);
  });

  test("runs as many checks at once as allowed, and frees a slot when one ends", async () => {
    const ffmpeg = fakeSpawner();
    const checker = createDecodeChecker({ ...settings, maxRunning: 1 }, ffmpeg.spawner);
    const first = checker.start();
    expect(first).toBeDefined();
    expect(checker.start()).toBeUndefined();
    first?.stop();
    expect(await first?.result).toBe(false);
    expect(checker.start()).toBeDefined();
    expect(ffmpeg.runs).toHaveLength(2);
  });

  test("feeds nothing once the check ended", async () => {
    const ffmpeg = fakeSpawner();
    const check = createDecodeChecker(settings, ffmpeg.spawner).start();
    check?.stop();
    await check?.result;
    check?.feed(new Uint8Array(1000));
    await new Promise((resolve) => setImmediate(resolve));
    expect(ffmpeg.runs[0]?.received()).toBe(0);
  });
});
