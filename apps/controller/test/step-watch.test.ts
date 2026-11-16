import { createLogger } from "@aceswarm/shared/logger";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StepWatch } from "../src/step-watch.ts";

/** A promise that stays pending until `open` is called. */
function latch() {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    promise,
    open: () => {
      resolve(undefined);
    },
  };
}

/** A watch that observes every second of a clock the test sets, and the times it observed at. */
function watching(observe?: () => Promise<void>) {
  const clock = { now: 0 };
  const observed: number[] = [];
  const watch = new StepWatch(
    1000,
    () => clock.now,
    createLogger("test", "silent"),
    async () => {
      observed.push(clock.now);
      await observe?.();
    },
  );
  /** A step that lasts until `finish`. */
  const step = () => {
    const done = latch();
    const running = watch.during(() => done.promise);
    return { running, finish: done.open };
  };
  return { clock, observed, watch, step };
}

describe("observing a step that takes long", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("observes nothing while no step runs", async () => {
    const { clock, observed, watch } = watching();
    clock.now = 10_000;
    await watch.check();
    expect(observed).toEqual([]);
  });

  test("observes a step once it took as long as the interval, and not before", async () => {
    const { clock, observed, watch, step } = watching();
    clock.now = 5000;
    const { running, finish } = step();
    clock.now += 999;
    await watch.check();
    expect(observed).toEqual([]);
    clock.now += 1;
    await watch.check();
    expect(observed).toEqual([6000]);
    finish();
    await running;
  });

  test("stops observing when the step is done", async () => {
    const { clock, observed, watch, step } = watching();
    const { running, finish } = step();
    clock.now += 5000;
    finish();
    await running;
    await watch.check();
    expect(observed).toEqual([]);
  });

  test("observes again later in the same step", async () => {
    const { clock, observed, watch, step } = watching();
    const { running, finish } = step();
    for (const at of [2000, 4000, 6000]) {
      clock.now = at;
      await watch.check();
    }
    expect(observed).toEqual([2000, 4000, 6000]);
    finish();
    await running;
  });

  test("starts no second observation while one is in progress", async () => {
    const slow = latch();
    const { clock, observed, watch, step } = watching(() => slow.promise);
    const { running, finish } = step();
    clock.now = 2000;
    const first = watch.check();
    clock.now = 4000;
    await watch.check();
    expect(observed).toEqual([2000]);
    slow.open();
    await first;
    finish();
    await running;
  });

  test("goes on after an observation failed", async () => {
    let fail = true;
    const { clock, observed, watch, step } = watching(() =>
      fail ? Promise.reject(new Error("nobody answered")) : Promise.resolve(),
    );
    const { running, finish } = step();
    clock.now = 2000;
    await expect(watch.check()).resolves.toBeUndefined();
    fail = false;
    clock.now = 4000;
    await watch.check();
    expect(observed).toEqual([2000, 4000]);
    finish();
    await running;
  });

  test("a step that throws is no longer observed", async () => {
    const { clock, observed, watch } = watching();
    await expect(watch.during(() => Promise.reject(new Error("the step failed")))).rejects.toThrow("the step failed");
    clock.now = 5000;
    await watch.check();
    expect(observed).toEqual([]);
  });

  test("observes on a timer once started, until stopped", async () => {
    vi.useFakeTimers();
    const { clock, observed, watch, step } = watching();
    watch.start();
    const { running, finish } = step();
    clock.now = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    clock.now = 2000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(observed).toEqual([1000, 2000]);

    watch.stop();
    clock.now = 3000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(observed).toEqual([1000, 2000]);
    finish();
    await running;
  });
});
