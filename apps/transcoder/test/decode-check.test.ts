import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  CHECK_PRIORITY,
  type CheckPriority,
  createDecodeChecker,
  DEFAULT_DECODE_CHECK_SETTINGS,
  type DecodeCheckSettings,
} from "../src/decode-check.ts";

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
    const check = createDecodeChecker(settings, { spawner: ffmpeg.spawner }).start({}, CHECK_PRIORITY.first);
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
    const checker = createDecodeChecker({ ...settings, timeoutMs: 20 }, { spawner: ffmpeg.spawner });
    const late = checker.start({}, CHECK_PRIORITY.first);
    ffmpeg.runs[0]?.stdout.write("frame=0\nprogress=continue\n");
    expect(await late?.result).toBe("no-video");
    expect(ffmpeg.runs[0]?.killed()).toBe(true);

    const exits = checker.start({}, CHECK_PRIORITY.first);
    ffmpeg.runs[1]?.child.emit("exit", 1, null);
    expect(await exits?.result).toBe("no-video");
  });

  test("says nothing when ffmpeg can't start, when its data stops coming, or when stopped", async () => {
    const ffmpeg = fakeSpawner();
    const checker = createDecodeChecker({ ...settings, quietMs: 30 }, { spawner: ffmpeg.spawner });
    const missing = checker.start({}, CHECK_PRIORITY.first);
    ffmpeg.runs[0]?.child.emit("error", new Error("spawn ffmpeg ENOENT"));
    expect(await missing?.result).toBe("inconclusive");

    const quiet = checker.start({}, CHECK_PRIORITY.first);
    quiet?.feed(new Uint8Array(100));
    expect(await quiet?.result).toBe("inconclusive");

    const stopped = checker.start({}, CHECK_PRIORITY.first);
    stopped?.stop();
    expect(await stopped?.result).toBe("inconclusive");
    stopped?.feed(new Uint8Array(1000));
    await nextTurn();
    expect(ffmpeg.runs[2]?.received()).toBe(0);

    const throws = createDecodeChecker(settings, {
      spawner: () => {
        throw new Error("spawn failed");
      },
    }).start({}, CHECK_PRIORITY.first);
    expect(await throws?.result).toBe("inconclusive");
  });

  test("runs as many checks at once as allowed, and hands out the next as one ends", async () => {
    const ffmpeg = fakeSpawner();
    const checker = createDecodeChecker({ ...settings, maxRunning: 2 }, { spawner: ffmpeg.spawner });
    const [a, b, c] = [{}, {}, {}];
    const first = checker.start(a, CHECK_PRIORITY.first);
    const second = checker.start(b, CHECK_PRIORITY.first);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(checker.start(c, CHECK_PRIORITY.first)).toBeUndefined();

    first?.stop();
    await first?.result;
    expect(checker.start(c, CHECK_PRIORITY.first)).toBeDefined();
    expect(ffmpeg.runs).toHaveLength(3);
  });

  test("goes by priority, then by who waited longest", async () => {
    const ffmpeg = fakeSpawner();
    const checker = createDecodeChecker({ ...settings, maxRunning: 1 }, { spawner: ffmpeg.spawner });
    const [routine, early, late, failed] = [{}, {}, {}, {}];
    const waiting = new Map<object, CheckPriority>([
      [routine, CHECK_PRIORITY.routine],
      [early, CHECK_PRIORITY.first],
      [late, CHECK_PRIORITY.first],
      [failed, CHECK_PRIORITY.afterFailure],
    ]);
    let running = checker.start({}, CHECK_PRIORITY.routine);
    for (const [who, priority] of waiting) {
      expect(checker.start(who, priority)).toBeUndefined();
    }

    // Each in turn, as the one before ends: a standby whose check failed (its data doesn't count
    // meanwhile), then the never checked ones by when they asked, then the routine re-check. The
    // others keep asking, in an order of their own.
    for (const next of [failed, early, late, routine]) {
      running?.stop();
      await running?.result;
      for (const [who, priority] of [...waiting].toReversed()) {
        if (who !== next) {
          expect(checker.start(who, priority)).toBeUndefined();
        }
      }
      running = checker.start(next, waiting.get(next) ?? CHECK_PRIORITY.routine);
      expect(running).toBeDefined();
      waiting.delete(next);
    }
    expect(ffmpeg.runs).toHaveLength(5);
  });

  test("forgets who stopped asking or left the line", async () => {
    const ffmpeg = fakeSpawner();
    const clock = { now: 0 };
    const checker = createDecodeChecker(
      { ...settings, maxRunning: 1 },
      { spawner: ffmpeg.spawner, now: () => clock.now },
    );
    const [quiet, left, asking] = [{}, {}, {}];
    const first = checker.start({}, CHECK_PRIORITY.first);
    expect(checker.start(quiet, CHECK_PRIORITY.first)).toBeUndefined();
    expect(checker.start(left, CHECK_PRIORITY.first)).toBeUndefined();
    checker.cancel(left);
    first?.stop();
    await first?.result;

    clock.now = 6000;
    expect(checker.start(asking, CHECK_PRIORITY.first)).toBeDefined();
  });

  test("finds no video when ffmpeg closes its input", async () => {
    const ffmpeg = fakeSpawner();
    const check = createDecodeChecker(settings, { spawner: ffmpeg.spawner }).start({}, CHECK_PRIORITY.first);
    ffmpeg.runs[0]?.stdin.emit("error", new Error("write EPIPE"));
    expect(await check?.result).toBe("no-video");
  });

  test("drops data that waits for ffmpeg past 8 MB", () => {
    let accepted = 0;
    const stdin = new Writable({
      highWaterMark: 1,
      write: () => {
        // Never done: the data waits, as for an ffmpeg that stopped reading.
      },
    });
    const write = stdin.write.bind(stdin);
    stdin.write = ((chunk: Uint8Array) => {
      accepted += chunk.length;
      return write(chunk);
    }) as typeof stdin.write;
    const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), kill: () => true });
    const check = createDecodeChecker(settings, { spawner: () => child as unknown as ChildProcess }).start(
      {},
      CHECK_PRIORITY.first,
    );
    for (let chunk = 0; chunk < 12; chunk += 1) {
      check?.feed(new Uint8Array(1024 * 1024));
    }
    expect(accepted).toBe(8 * 1024 * 1024);
    check?.stop();
  });

  test("says once when ffmpeg can't start, whether spawning throws or the process reports it", async () => {
    const errors: unknown[] = [];
    const onCannotStart = (error: unknown): void => {
      errors.push(error);
    };
    const throws = createDecodeChecker(settings, {
      spawner: () => {
        throw new Error("spawn ffmpeg ENOENT");
      },
      onCannotStart,
    });
    expect(await throws.start({}, CHECK_PRIORITY.first)?.result).toBe("inconclusive");
    expect(await throws.start({}, CHECK_PRIORITY.first)?.result).toBe("inconclusive");
    expect(errors).toHaveLength(1);

    // Node reports a missing or unrunnable ffmpeg through the process's error event.
    const ffmpeg = fakeSpawner();
    const reports = createDecodeChecker(settings, { spawner: ffmpeg.spawner, onCannotStart });
    for (let run = 0; run < 2; run += 1) {
      const check = reports.start({}, CHECK_PRIORITY.first);
      ffmpeg.runs[run]?.child.emit("error", new Error("spawn ffmpeg EACCES"));
      expect(await check?.result).toBe("inconclusive");
    }
    expect(errors).toHaveLength(2);
  });
});
