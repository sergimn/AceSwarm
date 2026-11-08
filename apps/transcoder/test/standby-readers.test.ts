import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, test, vi } from "vitest";
import {
  CHECK_PRIORITY,
  DEFAULT_DECODE_CHECK_SETTINGS,
  type CheckPriority,
  type DecodeCheck,
  type DecodeChecker,
  type DecodeResult,
} from "../src/decode-check.ts";
import type { LiveEdge } from "../src/live-edge.ts";
import { StandbyReaders } from "../src/standby-readers.ts";
import { noise, NULL_PID, tsPackets } from "./ts-fixtures.ts";

const logger = createLogger("test", "silent");
const settings = { idleTimeoutMs: 200, retryMs: 5 };

/** An engine whose playback URLs answer with a stream each test feeds by hand. */
function fakeEngine(status = 200) {
  const requests: { url: string; init: RequestInit; aborted: () => boolean }[] = [];
  const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ url, init, aborted: () => init.signal?.aborted === true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodies.push(controller);
        init.signal?.addEventListener("abort", () => {
          try {
            controller.error(new Error("aborted"));
          } catch {
            // Already closed.
          }
        });
      },
    });
    return Promise.resolve(new Response(body, { status }));
  };
  return { fetch, requests, bodies };
}

/** Decode checks that each test ends by hand. */
function fakeDecoder(free = true) {
  const checks: {
    fed: Uint8Array[];
    priority: CheckPriority;
    stopped: boolean;
    end: (result: DecodeResult) => void;
  }[] = [];
  const asked: { who: object; priority: CheckPriority }[] = [];
  const cancelled: object[] = [];
  const decoder: DecodeChecker = {
    settings: { ...DEFAULT_DECODE_CHECK_SETTINGS, intervalMs: 60_000, retryMs: 10_000, maxRetryMs: 30_000 },
    start: (who, priority): DecodeCheck | undefined => {
      asked.push({ who, priority });
      if (!free) {
        return undefined;
      }
      const { promise, resolve } = Promise.withResolvers<DecodeResult>();
      const check = { fed: [] as Uint8Array[], priority, stopped: false, end: resolve };
      checks.push(check);
      return {
        result: promise,
        feed: (chunk) => {
          check.fed.push(chunk);
        },
        stop: () => {
          check.stopped = true;
          resolve("inconclusive");
        },
      };
    },
    cancel: (who) => {
      cancelled.push(who);
    },
  };
  return { decoder, checks, asked, cancelled };
}

/** Lets every pending promise callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** How many bytes a check got. */
const fedBytes = (check: { fed: Uint8Array[] } | undefined): number =>
  (check?.fed ?? []).reduce((total, chunk) => total + chunk.length, 0);

describe("StandbyReaders", () => {
  test("only counts data that comes while the standby's live edge moves", async () => {
    const engine = fakeEngine();
    const clock = { now: 1000 };
    const edges = new Map<string, LiveEdge>();
    const stopped: string[] = [];
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => clock.now, {
      watch: (url, edge) => {
        edges.set(url, edge);
        return {
          edge,
          stop: () => {
            stopped.push(url);
          },
        };
      },
      liveEdge: { staleAfterMs: 60_000, noLiveAfterPolls: 10 },
    });
    readers.set([{ source: "http://e1/play", stat: "http://e1/stat" }]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    const edge = edges.get("http://e1/stat");
    // An engine whose broadcast stopped still serves its old window.
    edge?.observe({ status: "dl", downloaded: 1_000_000, last: 5000, pos: 5000 });
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ bytes: 940, lastDataAt: null, liveEdge: { state: "waiting" } });
    });

    for (const step of [1, 2, 3]) {
      clock.now = 1000 + step * 1000;
      edge?.observe({ status: "dl", downloaded: 1_000_000 + step * 50_000, last: 5000 + step, pos: 5000 + step });
    }
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({
        lastDataAt: new Date(4000).toISOString(),
        liveEdge: { state: "live" },
      });
    });

    clock.now = 70_000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ bytes: 2820, lastDataAt: new Date(4000).toISOString() });
    });
    expect(readers.status()[0]?.liveEdge?.state).toBe("stale");
    readers.closeAll();
    expect(stopped).toEqual(["http://e1/stat"]);
  });

  test("reads a standby session, following its redirect, and reports when data last came", async () => {
    const engine = fakeEngine();
    const clock = { now: 1000 };
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => clock.now);
    expect(readers.set(["http://e1/play"])).toMatchObject([{ source: "http://e1/play", state: "connecting" }]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    expect(engine.requests[0]?.init.redirect).toBe("follow");

    clock.now = 5000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()).toEqual([
        {
          source: "http://e1/play",
          state: "receiving",
          bytes: 1880,
          lastDataAt: new Date(5000).toISOString(),
          error: null,
          liveEdge: null,
        },
      ]);
    });
    readers.closeAll();
  });

  test.each([
    ["zeros", new Uint8Array(188 * 100)],
    ["random bytes", noise(188 * 100)],
    ["MPEG-TS padding only", tsPackets(100, NULL_PID)],
  ])("doesn't count %s as data, even while the live edge moves", async (_name, bytes) => {
    const engine = fakeEngine();
    const clock = { now: 1000 };
    let edge: LiveEdge | undefined;
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => clock.now, {
      watch: (_url, watched) => {
        edge = watched;
        return { edge: watched, stop: () => undefined };
      },
      liveEdge: { staleAfterMs: 60_000, noLiveAfterPolls: 10 },
    });
    readers.set([{ source: "http://e1/play", stat: "http://e1/stat" }]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    for (const step of [0, 1, 2, 3]) {
      clock.now = 1000 + step * 1000;
      edge?.observe({ status: "dl", downloaded: 1_000_000 + step * 50_000, last: 5000 + step, pos: 5000 + step });
    }
    expect(edge?.publishable()).toBe(true);
    engine.bodies[0]?.enqueue(bytes);
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ state: "receiving", bytes: bytes.length, lastDataAt: null });
    });
    readers.closeAll();
  });

  test("says when a standby gets plenty of data that isn't MPEG-TS video, until video comes", async () => {
    const engine = fakeEngine();
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => 5000);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    engine.bodies[0]?.enqueue(new Uint8Array(512 * 1024));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ bytes: 512 * 1024, error: null });
    });
    engine.bodies[0]?.enqueue(new Uint8Array(512 * 1024));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({
        lastDataAt: null,
        error: "the engine sends data that isn't MPEG-TS video",
      });
    });
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ lastDataAt: new Date(5000).toISOString(), error: null });
    });
    readers.closeAll();
  });

  test("counts data before its first decode check ends, and checks again a minute after one passed", async () => {
    const engine = fakeEngine();
    const { decoder, checks, asked } = fakeDecoder();
    const clock = { now: 1000 };
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => clock.now, undefined, decoder);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]?.lastDataAt).toBe(new Date(1000).toISOString());
    });
    // A standby never checked asks ahead of routine re-checks.
    expect(checks).toMatchObject([{ priority: CHECK_PRIORITY.first }]);
    expect(fedBytes(checks[0])).toBe(940);

    clock.now = 2000;
    checks[0]?.end("decoded");
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ lastDataAt: new Date(2000).toISOString(), error: null });
    });
    expect(checks).toHaveLength(1);

    clock.now = 2000 + 60_000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks).toHaveLength(2);
    });
    expect(checks[1]?.priority).toBe(CHECK_PRIORITY.routine);
    expect(asked.every(({ who }) => who === asked[0]?.who)).toBe(true);
    readers.closeAll();
    expect(checks[1]?.stopped).toBe(true);
  });

  test("stops counting data ffmpeg can't decode, says so, and waits longer after each failed check", async () => {
    const engine = fakeEngine();
    const { decoder, checks } = fakeDecoder();
    const clock = { now: 1000 };
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => clock.now, undefined, decoder);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    const failAt = async (at: number, count: number): Promise<void> => {
      clock.now = at;
      engine.bodies[0]?.enqueue(tsPackets(5));
      await vi.waitFor(() => {
        expect(checks).toHaveLength(count);
      });
      checks[count - 1]?.end("no-video");
    };
    await failAt(1000, 1);
    clock.now = 2000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({
        lastDataAt: new Date(1000).toISOString(),
        error: "ffmpeg decoded no video from it",
      });
    });

    // 10 s, then 20 s, then at most 30 s (maxRetryMs) between checks.
    clock.now = 1000 + 9999;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]?.bytes).toBe(940 * 3);
    });
    expect(checks).toHaveLength(1);
    await failAt(1000 + 10_000, 2);
    await failAt(11_000 + 20_000, 3);
    clock.now = 31_000 + 29_999;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]?.bytes).toBe(940 * 6);
    });
    expect(checks).toHaveLength(3);
    await failAt(31_000 + 30_000, 4);
    // After a failure, its data doesn't count: it asks ahead of the rest.
    expect(checks.map((check) => check.priority)).toEqual([
      CHECK_PRIORITY.first,
      CHECK_PRIORITY.afterFailure,
      CHECK_PRIORITY.afterFailure,
      CHECK_PRIORITY.afterFailure,
    ]);

    // A check that passes makes the data count again.
    clock.now = 61_000 + 30_000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks).toHaveLength(5);
    });
    checks[4]?.end("decoded");
    clock.now = 92_000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ lastDataAt: new Date(92_000).toISOString(), error: null });
    });
    readers.closeAll();
  });

  test("feeds a running check every chunk, so ffmpeg gets the stream without gaps", async () => {
    const engine = fakeEngine();
    const { decoder, checks } = fakeDecoder();
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => 1000, undefined, decoder);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    const stream = tsPackets(23);
    for (const [from, to] of [
      [0, 1880],
      [1880, 1980],
      [1980, 2100],
      [2100, stream.length],
    ] as const) {
      engine.bodies[0]?.enqueue(stream.subarray(from, to));
    }
    await vi.waitFor(() => {
      expect(fedBytes(checks[0])).toBe(stream.length);
    });
    readers.closeAll();
  });

  test("a check cut short by a new connection leaves the answer as it was, and the next one comes later", async () => {
    const engine = fakeEngine();
    const { decoder, checks, cancelled } = fakeDecoder();
    const clock = { now: 1000 };
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => clock.now, undefined, decoder);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks).toHaveLength(1);
    });
    // Fails at 1000: the next check comes 10 s later.
    checks[0]?.end("no-video");
    await settle();
    clock.now = 11_000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks).toHaveLength(2);
    });
    expect(checks[1]?.priority).toBe(CHECK_PRIORITY.afterFailure);

    // The connection drops mid-check at 11 000: the check stops and says nothing.
    engine.bodies[0]?.close();
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(2);
    });
    expect(checks[1]?.stopped).toBe(true);
    expect(cancelled).toHaveLength(1);
    clock.now = 15_000;
    engine.bodies[1]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ bytes: 940 * 3, error: "ffmpeg decoded no video from it" });
    });
    expect(readers.status()[0]?.lastDataAt).toBe(new Date(1000).toISOString());
    expect(checks).toHaveLength(2);

    // The next one comes 10 s after the one cut short.
    clock.now = 21_000;
    engine.bodies[1]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks).toHaveLength(3);
    });
    expect(checks[2]?.priority).toBe(CHECK_PRIORITY.afterFailure);

    // Cut short again at 21 000: the wait doubles, to 20 s.
    engine.bodies[1]?.close();
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(3);
    });
    clock.now = 21_000 + 19_999;
    engine.bodies[2]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]?.bytes).toBe(940 * 5);
    });
    expect(checks).toHaveLength(3);
    clock.now = 21_000 + 20_000;
    engine.bodies[2]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks).toHaveLength(4);
    });
    readers.closeAll();
  });

  test("stops a running check when ffmpeg takes the standby's source", async () => {
    const engine = fakeEngine();
    const { decoder, checks, cancelled } = fakeDecoder();
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => 1000, undefined, decoder);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks).toHaveLength(1);
    });
    const released = readers.release("http://e1/play");
    expect(checks[0]?.stopped).toBe(true);
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
    expect(await released).toBe(true);
  });

  test("asks for no decode check on data that isn't MPEG-TS, and waits while none is free", async () => {
    const engine = fakeEngine();
    const zeros = fakeDecoder();
    const busy = fakeDecoder(false);
    const first = new StandbyReaders(logger, settings, engine.fetch, () => 1000, undefined, zeros.decoder);
    const second = new StandbyReaders(logger, settings, engine.fetch, () => 1000, undefined, busy.decoder);
    first.set(["http://e1/play"]);
    second.set(["http://e2/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(2);
    });
    engine.bodies[0]?.enqueue(new Uint8Array(188 * 100));
    engine.bodies[1]?.enqueue(tsPackets(100));
    engine.bodies[1]?.enqueue(tsPackets(100));
    await vi.waitFor(() => {
      expect(first.status()[0]?.bytes).toBe(188 * 100);
      expect(second.status()[0]?.bytes).toBe(188 * 200);
    });
    expect(zeros.asked).toHaveLength(0);
    // It keeps its place in line by asking on each chunk, and its data counts meanwhile.
    expect(busy.asked).toHaveLength(2);
    expect(second.status()[0]?.lastDataAt).toBe(new Date(1000).toISOString());
    first.closeAll();
    second.closeAll();
  });

  test("reads exactly the sources it is given, and stops the others", async () => {
    const engine = fakeEngine();
    const readers = new StandbyReaders(logger, settings, engine.fetch);
    readers.set(["http://e1/play", "http://e2/play"]);
    await vi.waitFor(() => {
      expect(engine.requests).toHaveLength(2);
    });
    readers.set(["http://e2/play", "http://e3/play"]);
    await vi.waitFor(() => {
      expect(engine.requests).toHaveLength(3);
    });
    expect(engine.requests.map((request) => [request.url, request.aborted()])).toEqual([
      ["http://e1/play", true],
      ["http://e2/play", false],
      ["http://e3/play", false],
    ]);
    expect(readers.size).toBe(2);
    readers.closeAll();
    expect(engine.requests.every((request) => request.aborted())).toBe(true);
    expect(readers.size).toBe(0);
  });

  test("lets go of a source ffmpeg takes over: the engine allows one reader per session", async () => {
    const engine = fakeEngine();
    const readers = new StandbyReaders(logger, settings, engine.fetch);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.requests).toHaveLength(1);
    });
    const released = readers.release("http://e1/play");
    expect(engine.requests[0]?.aborted()).toBe(true);
    expect(readers.status()).toEqual([]);
    expect(await released).toBe(true);
    // A source without a reader: nothing to wait for.
    expect(await readers.release("http://e1/play")).toBe(false);
  });

  test("lets go of a source only once its connection is closed and the engine had time to notice", async () => {
    const engine = fakeEngine();
    const readers = new StandbyReaders(logger, { ...settings, releaseGraceMs: 50 }, engine.fetch);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    const startedAt = performance.now();
    expect(await readers.release("http://e1/play")).toBe(true);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(45);
    expect(engine.requests).toHaveLength(1);
  });

  test("connects again when the engine ends the stream", async () => {
    const engine = fakeEngine();
    const readers = new StandbyReaders(logger, settings, engine.fetch);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    engine.bodies[0]?.close();
    await vi.waitFor(() => {
      expect(engine.requests).toHaveLength(2);
    });
    readers.closeAll();
  });

  test("drops a connection that brings no data, and connects again", async () => {
    const engine = fakeEngine();
    const readers = new StandbyReaders(logger, { idleTimeoutMs: 20, retryMs: 5 }, engine.fetch);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.requests.length).toBeGreaterThanOrEqual(2);
    });
    expect(engine.requests[0]?.aborted()).toBe(true);
    expect(readers.status()[0]?.lastDataAt).toBeNull();
    readers.closeAll();
  });

  test("says what the engine answered when it refuses the session", async () => {
    const engine = fakeEngine(500);
    const readers = new StandbyReaders(logger, { idleTimeoutMs: 200, retryMs: 1000 }, engine.fetch);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(readers.status()).toMatchObject([{ state: "waiting", error: "the engine answered 500" }]);
    });
    readers.closeAll();
  });
});
