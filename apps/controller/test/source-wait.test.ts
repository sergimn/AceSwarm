import type { LiveEdgeView } from "@aceswarm/shared/api-types";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import { SourceWait } from "../src/source-wait.ts";

const USUAL = { baseDelayMs: 5000, maxDelayMs: 300_000 };

function edge(state: LiveEdgeView["state"], edgeAtSeconds: number | null): LiveEdgeView {
  return {
    state,
    edgeAt: edgeAtSeconds === null ? null : new Date(edgeAtSeconds * 1000).toISOString(),
    advancedAt: null,
    behindSeconds: 0,
  };
}

function waiting(): SourceWait {
  return new SourceWait(createLogger("test", "silent"), USUAL, 30_000);
}

describe("SourceWait", () => {
  it("changes nothing until the source is stale", () => {
    const wait = waiting();
    expect(wait.waiting).toBe(false);
    expect(wait.waits(USUAL)).toBe(USUAL);
    expect(wait.state("recovering")).toBe("recovering");
    expect(wait.starting("waiting for video")).toBe("waiting for video");
    expect(wait.moved(edge("live", 6000))).toBe(false);
  });

  it("waits longer between steps and shows every state as waiting for the source", () => {
    const wait = waiting();
    wait.begin("no new data from the broadcast for 61s", edge("stale", 5000));
    expect(wait.waiting).toBe(true);
    expect(wait.waits(USUAL)).toEqual({ baseDelayMs: 30_000, maxDelayMs: 300_000 });
    expect(wait.state("recovering")).toBe("stale-source");
    expect(wait.starting("engine is buffering")).toBe("waiting for the broadcast; engine is buffering");
    wait.end();
    expect(wait.waiting).toBe(false);
    expect(wait.state("stalled")).toBe("stalled");
  });

  it("never waits less than its first wait, even with a shorter usual maximum", () => {
    const wait = new SourceWait(createLogger("test", "silent"), { baseDelayMs: 1000, maxDelayMs: 4000 }, 10_000);
    wait.begin("stale", null);
    expect(wait.waits(USUAL)).toEqual({ baseDelayMs: 10_000, maxDelayMs: 10_000 });
  });

  it("tries early once when the live edge it waits on moves, then only when a step is due", () => {
    const wait = waiting();
    wait.begin("stale", edge("stale", 5000));
    expect(wait.moved(edge("stale", 5000))).toBe(false);
    // A session that only has the same window, or an older one, is no news.
    expect(wait.moved(edge("waiting", 4990))).toBe(false);
    expect(wait.moved(edge("live", 5003))).toBe(true);
    expect(wait.moved(edge("live", 5010))).toBe(false);
    // Not due yet: still no early try.
    expect(wait.until(2000, 1000, edge("live", 5011))).toBe(1000);
    expect(wait.until(1000, 1000, edge("live", 5011))).toBe(0);
    expect(wait.until(5000, 1000, edge("live", 5012))).toBe(0);
  });

  it("does not try early for an edge that moves while the engine serves far behind it", () => {
    const wait = waiting();
    wait.begin("stale", edge("stale", 5000));
    expect(wait.moved(edge("stale", 5100))).toBe(false);
    wait.due();
    expect(wait.moved(edge("live", 5100))).toBe(false);
    expect(wait.moved(edge("live", 5101))).toBe(true);
  });

  it("learns the edge it waits on from the first one it sees, when it began without one", () => {
    const wait = waiting();
    wait.begin("no video after 90s", null);
    expect(wait.moved(edge("waiting", 5000))).toBe(false);
    expect(wait.moved(edge("live", 5001))).toBe(true);
  });
});
