import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, test, vi } from "vitest";
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
    readers.release("http://e1/play");
    expect(engine.requests[0]?.aborted()).toBe(true);
    expect(readers.status()).toEqual([]);
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
