import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_DECODE_CHECK_SETTINGS, type DecodeCheck, type DecodeChecker } from "../src/decode-check.ts";
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

/** Decode checks that each test ends by hand, with or without video. */
function fakeDecoder(free = true) {
  const checks: { fed: number; stopped: boolean; end: (decoded: boolean) => void }[] = [];
  const decoder: DecodeChecker = {
    settings: { ...DEFAULT_DECODE_CHECK_SETTINGS, intervalMs: 60_000, retryMs: 10_000 },
    start: (): DecodeCheck | undefined => {
      if (!free) {
        return undefined;
      }
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const check = { fed: 0, stopped: false, end: resolve };
      checks.push(check);
      return {
        result: promise,
        feed: (chunk) => {
          check.fed += chunk.length;
        },
        stop: () => {
          check.stopped = true;
          resolve(false);
        },
      };
    },
  };
  return { decoder, checks };
}

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

  test("counts data once ffmpeg decoded video from it, and checks again a minute later", async () => {
    const engine = fakeEngine();
    const { decoder, checks } = fakeDecoder();
    const clock = { now: 1000 };
    const readers = new StandbyReaders(logger, settings, engine.fetch, () => clock.now, undefined, decoder);
    readers.set(["http://e1/play"]);
    await vi.waitFor(() => {
      expect(engine.bodies).toHaveLength(1);
    });
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks[0]?.fed).toBe(940);
    });
    expect(readers.status()[0]?.lastDataAt).toBeNull();

    clock.now = 2000;
    checks[0]?.end(true);
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
    // While the next check runs, the last one's answer holds.
    expect(readers.status()[0]?.lastDataAt).toBe(new Date(62_000).toISOString());
    readers.closeAll();
    expect(checks[1]?.stopped).toBe(true);
  });

  test("stops counting data ffmpeg can't decode, says so, and checks again sooner", async () => {
    const engine = fakeEngine();
    const { decoder, checks } = fakeDecoder();
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
    clock.now = 2000;
    checks[0]?.end(false);
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ lastDataAt: null, error: "ffmpeg decoded no video from it" });
    });
    expect(checks).toHaveLength(1);

    // The failed check ended at 2000.
    clock.now = 2000 + 10_000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(checks).toHaveLength(2);
    });
    checks[1]?.end(true);
    clock.now = 13_000;
    engine.bodies[0]?.enqueue(tsPackets(5));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ lastDataAt: new Date(13_000).toISOString(), error: null });
    });
    readers.closeAll();
  });

  test("starts no decode check on data that isn't MPEG-TS, nor while no check is free", async () => {
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
    await vi.waitFor(() => {
      expect(first.status()[0]?.bytes).toBe(188 * 100);
      expect(second.status()[0]?.bytes).toBe(188 * 100);
    });
    expect(zeros.checks).toHaveLength(0);
    expect(second.status()[0]?.lastDataAt).toBeNull();
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
