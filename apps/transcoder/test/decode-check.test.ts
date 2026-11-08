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

const settings: DecodeCheckSettings = {
  ...DEFAULT_DECODE_CHECK_SETTINGS,
  minFrames: 5,
  timeoutMs: 5000,
  maxRunning: 2,
};

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe("createDecodeChecker", () => {
  test("has ffmpeg decode the first video stream of MPEG-TS from stdin, and passes once enough frames came", async () => {
    const ffmpeg = fakeSpawner();
    const check = createDecodeChecker(settings, ffmpeg.spawner).start({}, true);
    const run = ffmpeg.runs[0];
    expect(run?.args.join(" ")).toContain("-f mpegts -i pipe:0 -map 0:v:0 -f null");
    expect(run?.args.join(" ")).toContain("-progress pipe:1");

    check?.feed(new Uint8Array(1000));
    await nextTurn();
    expect(run?.received()).toBe(1000);

    run?.stdout.write("frame=2\nprogress=continue\n");
    run?.stdout.write("frame=5\nprogress=continue\n");
    expect(await check?.result).toBe("decoded");
    expect(run?.killed()).toBe(true);
  });

  test("finds no video when no frames come in time, or when ffmpeg gives up on the data", async () => {
    const ffmpeg = fakeSpawner();
    const checker = createDecodeChecker({ ...settings, timeoutMs: 20 }, ffmpeg.spawner);
    const late = checker.start({}, true);
    ffmpeg.runs[0]?.stdout.write("frame=0\nprogress=continue\n");
    expect(await late?.result).toBe("no-video");
    expect(ffmpeg.runs[0]?.killed()).toBe(true);

    const exits = checker.start({}, true);
    ffmpeg.runs[1]?.child.emit("exit", 1, null);
    expect(await exits?.result).toBe("no-video");
  });

  test("says nothing when ffmpeg can't start, when its data stops coming, or when stopped", async () => {
    const ffmpeg = fakeSpawner();
    const checker = createDecodeChecker({ ...settings, quietMs: 30 }, ffmpeg.spawner);
    const missing = checker.start({}, true);
    ffmpeg.runs[0]?.child.emit("error", new Error("spawn ffmpeg ENOENT"));
    expect(await missing?.result).toBe("inconclusive");

    const quiet = checker.start({}, true);
    quiet?.feed(new Uint8Array(100));
    expect(await quiet?.result).toBe("inconclusive");

    const stopped = checker.start({}, true);
    stopped?.stop();
    expect(await stopped?.result).toBe("inconclusive");
    stopped?.feed(new Uint8Array(1000));
    await nextTurn();
    expect(ffmpeg.runs[2]?.received()).toBe(0);

    const throws = createDecodeChecker(settings, () => {
      throw new Error("spawn failed");
    }).start({}, true);
    expect(await throws?.result).toBe("inconclusive");
  });

  test("runs as many checks at once as allowed, urgent ones first, then by who waited longest", async () => {
    const ffmpeg = fakeSpawner();
    const checker = createDecodeChecker({ ...settings, maxRunning: 1 }, ffmpeg.spawner);
    const [a, routine, urgent] = [{}, {}, {}];
    const first = checker.start(a, false);
    expect(first).toBeDefined();
    expect(checker.start(routine, false)).toBeUndefined();
    expect(checker.start(urgent, true)).toBeUndefined();

    first?.stop();
    await first?.result;
    // The routine re-check asked first, but a standby without a passed check goes first.
    expect(checker.start(routine, false)).toBeUndefined();
    const second = checker.start(urgent, true);
    expect(second).toBeDefined();
    second?.stop();
    await second?.result;
    expect(checker.start(routine, false)).toBeDefined();
    expect(ffmpeg.runs).toHaveLength(3);
  });

  test("forgets who stopped asking or left the line", async () => {
    const ffmpeg = fakeSpawner();
    const clock = { now: 0 };
    const checker = createDecodeChecker({ ...settings, maxRunning: 1 }, ffmpeg.spawner, () => clock.now);
    const [quiet, left, asking] = [{}, {}, {}];
    const first = checker.start({}, true);
    expect(checker.start(quiet, true)).toBeUndefined();
    expect(checker.start(left, true)).toBeUndefined();
    checker.cancel(left);
    first?.stop();
    await first?.result;

    clock.now = 6000;
    expect(checker.start(asking, true)).toBeDefined();
  });
});
