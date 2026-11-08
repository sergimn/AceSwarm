import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, test, vi } from "vitest";
import type { LiveEdge } from "../src/live-edge.ts";
import { StandbyReaders } from "../src/standby-readers.ts";

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
    engine.bodies[0]?.enqueue(new Uint8Array(188));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ bytes: 188, lastDataAt: null, liveEdge: { state: "waiting" } });
    });

    clock.now = 1500;
    edge?.observe({ status: "dl", downloaded: 1_050_000, last: 5001, pos: 5001 });
    clock.now = 2000;
    edge?.observe({ status: "dl", downloaded: 1_100_000, last: 5002, pos: 5002 });
    engine.bodies[0]?.enqueue(new Uint8Array(188));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({
        lastDataAt: new Date(2000).toISOString(),
        liveEdge: { state: "live" },
      });
    });

    clock.now = 70_000;
    engine.bodies[0]?.enqueue(new Uint8Array(188));
    await vi.waitFor(() => {
      expect(readers.status()[0]).toMatchObject({ bytes: 564, lastDataAt: new Date(2000).toISOString() });
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
    engine.bodies[0]?.enqueue(new Uint8Array(188));
    engine.bodies[0]?.enqueue(new Uint8Array(188));
    await vi.waitFor(() => {
      expect(readers.status()).toEqual([
        {
          source: "http://e1/play",
          state: "receiving",
          bytes: 376,
          lastDataAt: new Date(5000).toISOString(),
          error: null,
          liveEdge: null,
        },
      ]);
    });
    readers.closeAll();
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
