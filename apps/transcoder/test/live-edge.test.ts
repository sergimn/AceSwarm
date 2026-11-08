import { describe, expect, it } from "vitest";
import { LiveEdge, parseLiveSample, type LiveSample } from "../src/live-edge.ts";

const SETTINGS = { staleAfterMs: 60_000, noLiveAfterPolls: 3 };

function sample(last: number | undefined, downloaded: number, pos = last): LiveSample {
  return { status: "dl", downloaded, last, pos };
}

function edgeWithClock(seed?: { edge: number; since: number }): { edge: LiveEdge; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  return { edge: new LiveEdge(SETTINGS, () => clock.now, seed), clock };
}

/** One sample a second, the edge one second further each time, as a live broadcast's. */
function feed(edge: LiveEdge, clock: { now: number }, lasts: number[], behind = 0): void {
  for (const [index, last] of lasts.entries()) {
    if (index > 0) {
      clock.now += 1000;
    }
    edge.observe(sample(last, 100 + index * 100, last - behind));
  }
}

describe("LiveEdge", () => {
  it("counts a new session once its edge kept moving at the broadcast's pace and it downloaded", () => {
    const { edge, clock } = edgeWithClock();
    expect(edge.state()).toBe("waiting");
    // The edge moves, but nothing came yet: an engine that only learned of newer pieces.
    for (const last of [5000, 5001, 5002, 5003]) {
      edge.observe(sample(last, 100));
      expect(edge.state()).toBe("waiting");
      clock.now += 1000;
    }
    edge.observe(sample(5004, 300));
    expect(edge.state()).toBe("live");
    expect(edge.publishable()).toBe(true);
  });

  it("does not count an edge that only rises faster than time passes, as one catching up on an old window", () => {
    const { edge, clock } = edgeWithClock();
    feed(edge, clock, [4990, 4995, 5000, 5005, 5010]);
    expect(edge.state()).toBe("waiting");
    // Once the engine has the whole window, its edge stops: it never counted.
    clock.now += 60_000;
    edge.observe(sample(5010, 900));
    expect(edge.state()).toBe("waiting");
    clock.now += 1;
    expect(edge.state()).toBe("stale");
  });

  it("goes stale once the edge did not move for the threshold, by its own clock", () => {
    const { edge, clock } = edgeWithClock();
    feed(edge, clock, [5000, 5001, 5002, 5003]);
    expect(edge.state()).toBe("live");
    // The broadcaster's clock is far ahead of ours: only whether the edge moves counts.
    clock.now += 60_000;
    edge.observe(sample(5003, 500));
    expect(edge.state()).toBe("live");
    clock.now += 1;
    expect(edge.state()).toBe("stale");
    expect(edge.publishable()).toBe(false);
    expect(edge.view()).toMatchObject({
      state: "stale",
      edgeAt: new Date(5_003_000).toISOString(),
      advancedAt: new Date(1_003_000).toISOString(),
    });
  });

  it("goes stale when a session's edge never moves, counting from when it was first seen", () => {
    const { edge, clock } = edgeWithClock();
    edge.observe({ status: "prebuf", downloaded: 0, last: undefined, pos: undefined });
    clock.now += 30_000;
    edge.observe(sample(5000, 7_340_032));
    clock.now += 60_000;
    edge.observe(sample(5000, 7_340_032));
    expect(edge.state()).toBe("waiting");
    clock.now += 1;
    expect(edge.state()).toBe("stale");
  });

  it("does not count an edge that goes back and forth as moving", () => {
    const { edge, clock } = edgeWithClock();
    edge.observe(sample(5000, 100));
    for (let step = 0; step < 70; step += 1) {
      clock.now += 1000;
      edge.observe(sample(step % 2 === 0 ? 4990 : 5000, 100 + step));
    }
    expect(edge.state()).toBe("stale");
  });

  it("is stale when the engine serves the stream far behind its live edge", () => {
    const { edge, clock } = edgeWithClock();
    feed(edge, clock, [5000, 5001, 5002, 5003], 1);
    expect(edge.state()).toBe("live");
    clock.now += 1000;
    edge.observe(sample(5004, 500, 4943));
    expect(edge.state()).toBe("stale");
    expect(edge.view().behindSeconds).toBe(61);
  });

  it("starts from the stream's previous session: the same old window is stale at once", () => {
    // The previous session's edge stopped 50 s ago.
    const { edge, clock } = edgeWithClock({ edge: 5000, since: 1_000_000 - 50_000 });
    edge.observe(sample(4999, 2_000_000));
    expect(edge.state()).toBe("waiting");
    clock.now += 10_001;
    expect(edge.state()).toBe("stale");
  });

  it("starts from the stream's previous session: a newer edge still has to move", () => {
    const { edge, clock } = edgeWithClock({ edge: 5000, since: 1_000_000 - 600_000 });
    edge.observe(sample(5400, 100));
    expect(edge.state()).toBe("waiting");
    clock.now += 1000;
    edge.observe(sample(5400, 200));
    expect(edge.state()).toBe("waiting");
    for (const last of [5401, 5402, 5403]) {
      clock.now += 1000;
      edge.observe(sample(last, 200 + last));
    }
    expect(edge.state()).toBe("live");
  });

  it("does not count a slightly later end of the old window as the broadcast moving", () => {
    // Another engine knew of a few more seconds of the window than the previous session did.
    const { edge, clock } = edgeWithClock({ edge: 5000, since: 1_000_000 - 50_000 });
    edge.observe(sample(5003, 100));
    for (let poll = 1; poll <= 60; poll += 1) {
      clock.now += 1000;
      edge.observe(sample(5003, 100 + poll * 10_000));
      expect(edge.state()).toBe("waiting");
    }
    clock.now += 1;
    expect(edge.state()).toBe("stale");
  });

  it("does not count catching up past the previous session's edge as the broadcast moving", () => {
    // A peer had a few more seconds of the window: the new engine rises through it, past 5000.
    const { edge, clock } = edgeWithClock({ edge: 5000, since: 1_000_000 - 10_000 });
    feed(edge, clock, [4990, 4995, 5003]);
    for (let poll = 1; poll <= 60; poll += 1) {
      clock.now += 1000;
      edge.observe(sample(5003, 300 + poll * 10_000));
      expect(edge.state()).toBe("waiting");
    }
    clock.now += 1;
    expect(edge.state()).toBe("stale");
  });

  it("does not count catching up on the old window as the broadcast moving", () => {
    const { edge, clock } = edgeWithClock({ edge: 5000, since: 1_000_000 - 10_000 });
    for (const last of [4990, 4995, 5000]) {
      edge.observe(sample(last, last * 100));
      clock.now += 1000;
    }
    expect(edge.state()).toBe("waiting");
    clock.now += 48_000;
    expect(edge.state()).toBe("stale");
  });

  it("does not hold a session to an edge far ahead of it, as after the broadcaster's clock jumped back", () => {
    const { edge, clock } = edgeWithClock({ edge: 9000, since: 1_000_000 - 600_000 });
    edge.observe(sample(5000, 100));
    expect(edge.state()).toBe("waiting");
    feed(edge, clock, [5000, 5001, 5002, 5003]);
    expect(edge.state()).toBe("live");
  });

  it("has no live position when the session downloads without one, or its stats keep failing", () => {
    const vod = edgeWithClock().edge;
    vod.observe({ status: "prebuf", downloaded: 0, last: undefined, pos: undefined });
    for (let poll = 0; poll < 3; poll += 1) {
      expect(vod.state()).toBe("waiting");
      vod.observe({ status: "dl", downloaded: 100 * poll, last: undefined, pos: undefined });
    }
    expect(vod.state()).toBe("none");
    expect(vod.publishable()).toBe(true);

    const failing = edgeWithClock().edge;
    failing.failed();
    failing.failed();
    expect(failing.state()).toBe("waiting");
    failing.failed();
    expect(failing.state()).toBe("none");
  });

  it("keeps a session it saw an edge for stale when its stats stop answering", () => {
    const { edge, clock } = edgeWithClock();
    edge.observe(sample(5000, 100));
    for (let poll = 0; poll < 70; poll += 1) {
      clock.now += 1000;
      edge.failed();
    }
    expect(edge.state()).toBe("stale");
  });
});

describe("parseLiveSample", () => {
  it("reads the engine's livepos, whose numbers are strings", () => {
    const body = {
      response: {
        status: "dl",
        downloaded: 7_340_032,
        livepos: { pos: "1794080650", last: "1794080654", live_first: "1794078854", is_live: "1" },
      },
      error: null,
    };
    expect(parseLiveSample(body)).toEqual({
      status: "dl",
      downloaded: 7_340_032,
      last: 1_794_080_654,
      pos: 1_794_080_650,
    });
  });

  it("has no live position while the engine buffers, and nothing for an error", () => {
    expect(parseLiveSample({ response: { status: "prebuf", downloaded: 0 }, error: null })).toEqual({
      status: "prebuf",
      downloaded: 0,
      last: undefined,
      pos: undefined,
    });
    expect(parseLiveSample({ response: null, error: "unknown playback session id" })).toBeUndefined();
    expect(parseLiveSample("nope")).toBeUndefined();
  });
});
