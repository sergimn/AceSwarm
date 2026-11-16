import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@aceswarm/shared/logger";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StepLoop } from "../src/step-loop.ts";

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

/** A loop of the given steps, with a clock the test sets. */
function looping(step: () => Promise<void>, delayMs = 100) {
  const clock = { now: 0 };
  const logger = createLogger("test", "silent");
  const failed = vi.spyOn(logger, "error");
  const instance = new StepLoop({ delayMs, now: () => clock.now, logger, step, observe: () => Promise.resolve() });
  return { clock, failed, instance };
}

describe("a loop of supervision steps", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("runs the first step at once, and each next one a delay after the previous one ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const runs: number[] = [];
    const { clock, instance } = looping(() => {
      runs.push(clock.now);
      return Promise.resolve();
    });
    expect(instance.running).toBe(false);
    instance.start();
    expect(instance.running).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual([0]);

    await vi.advanceTimersByTimeAsync(99);
    expect(runs).toEqual([0]);
    clock.now = 100;
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual([0, 100]);

    await instance.stop(Infinity);
  });

  test("starting twice runs one loop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let runs = 0;
    const { instance } = looping(() => {
      runs += 1;
      return Promise.resolve();
    });
    instance.start();
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await instance.stop(Infinity);
  });

  test("a step that fails is logged, and the loop goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let runs = 0;
    const { failed, instance } = looping(() => {
      runs += 1;
      return runs === 1 ? Promise.reject(new Error("a step broke")) : Promise.resolve();
    });
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(runs).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toBe(2);
    expect(failed).toHaveBeenCalledTimes(1);
    await instance.stop(Infinity);
  });

  test("stopping starts no further step, and waits at most as long as asked for the one running", async () => {
    let runs = 0;
    const running = latch();
    const { instance } = looping(async () => {
      runs += 1;
      return running.promise;
    }, 5);
    instance.start();
    await vi.waitFor(() => {
      expect(runs).toBe(1);
    });

    // The step is still running: stopping gives up waiting for it.
    await instance.stop(10);
    expect(instance.running).toBe(false);
    running.open();
    await sleep(50);
    expect(runs).toBe(1);
  });

  test("started behind a previous run, it waits for it, and starts even if it failed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let runs = 0;
    const { instance } = looping(() => {
      runs += 1;
      return Promise.resolve();
    });
    const previous = Promise.withResolvers<undefined>();
    instance.start(previous.promise);
    expect(instance.running).toBe(true);
    expect(instance.waiting).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(0);

    previous.reject(new Error("the teardown failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.waiting).toBe(false);
    expect(runs).toBe(1);
    await instance.stop(Infinity);
  });

  test("stopped while it waits for a previous run, it starts none and ends after that run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let runs = 0;
    const { instance } = looping(() => {
      runs += 1;
      return Promise.resolve();
    });
    const previous = Promise.withResolvers<undefined>();
    instance.start(previous.promise);
    let stopped = false;
    const stopping = instance.stop(Infinity).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(false);

    previous.resolve(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(runs).toBe(0);
  });

  test("a stop before the first step ran starts none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let runs = 0;
    const { instance } = looping(() => {
      runs += 1;
      return Promise.resolve();
    });
    instance.start();
    const stopping = instance.stop(Infinity);
    await vi.advanceTimersByTimeAsync(1000);
    await stopping;
    expect(runs).toBe(0);
  });
});
