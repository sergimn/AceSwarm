import { describe, expect, it } from "vitest";
import type { PathStatus, StandbyView, StreamView } from "@aceswarm/shared/api-types";
import { pictureRect, PLAYER_STATS, playerStats } from "../src/player-stats.ts";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();
const LIVE = { now: NOW, stale: false };

const paths: PathStatus[] = [
  {
    id: "wg:mullvad-de",
    kind: "wireguard",
    label: "mullvad-de",
    up: true,
    rttMs: null,
    loss: null,
    handshakeAgeSeconds: null,
    score: 1,
    lastProbeAt: null,
    error: null,
  },
];

function stream(overrides: Partial<StreamView>): StreamView {
  return {
    enabled: true,
    state: "playing",
    lastFrameAt: ago(2),
    peers: { connected: 14, active: 9 },
    downloadKBps: 612,
    path: "direct",
    engine: { name: "engine", shared: false },
    standbys: [],
    ...overrides,
  } as StreamView;
}

const standby = (path: string, state: StandbyView["state"], reason: string | null = null): StandbyView => ({
  path,
  state,
  engine: null,
  reason,
});

describe("playerStats", () => {
  it("lists a playing stream's state, last frame, peers, speed and path", () => {
    expect(playerStats(stream({}), paths, LIVE)).toEqual({
      state: "playing",
      values: {
        state: "Live",
        "last-frame": "Now",
        peers: "9 sending · 14 connected",
        speed: "612 KiB/s",
        path: "Direct",
      },
    });
  });

  it("puts each standby on a line of its own, with why it is not hot", () => {
    const { values } = playerStats(
      stream({
        path: "wg:mullvad-de",
        standbys: [standby("direct", "hot"), standby("wg:other", "warming", "ffmpeg decoded no video from it")],
      }),
      paths,
      LIVE,
    );
    expect(values.path).toBe("mullvad-de");
    expect(values.standby).toBe("Direct (hot)\nother (warming up: ffmpeg decoded no video from it)");
  });

  it("only says the state and the age of the last frame of a disabled stream", () => {
    // It has no engine: no peers, no speed, no path, and no standby either.
    const disabled = stream({
      enabled: false,
      state: "playing",
      lastFrameAt: ago(180),
      standbys: [standby("x", "hot")],
    });
    expect(playerStats(disabled, paths, LIVE)).toEqual({
      state: "stopped",
      values: { state: "Disabled", "last-frame": "3m ago" },
    });
  });

  it('doesn\'t say "Now" while the page hears nothing, or for a stream that is not playing', () => {
    expect(playerStats(stream({}), paths, { now: NOW, stale: true }).values["last-frame"]).toBe("2s ago");
    expect(playerStats(stream({ state: "stalled" }), paths, LIVE).values["last-frame"]).toBe("2s ago");
  });

  it("names a shared engine's sending peers", () => {
    const shared = stream({ engine: { name: "engine", shared: true } });
    expect(playerStats(shared, paths, LIVE).values.peers).toBe("14 connected · 9 sending on the shared engine");
  });

  it("only uses keys the stats window has a line for", () => {
    const { values } = playerStats(stream({ standbys: [standby("direct", "hot")] }), paths, LIVE);
    expect(Object.keys(values)).toEqual(Object.keys(PLAYER_STATS));
  });
});

describe("pictureRect", () => {
  const screen = { width: 1280, height: 720 };

  it("fills a screen of the picture's shape", () => {
    expect(pictureRect(screen, { width: 1920, height: 1080 })).toEqual({ left: 0, top: 0, width: 1280, height: 720 });
  });

  it("leaves black bars on the sides of a narrower picture", () => {
    expect(pictureRect(screen, { width: 640, height: 480 })).toEqual({ left: 160, top: 0, width: 960, height: 720 });
    expect(pictureRect(screen, { width: 1080, height: 1920 })).toEqual({
      left: 437.5,
      top: 0,
      width: 405,
      height: 720,
    });
  });

  it("leaves black bars above and below a wider picture", () => {
    expect(pictureRect(screen, { width: 2100, height: 900 })).toEqual({
      left: 0,
      top: 85.71428571428572,
      width: 1280,
      height: 548.5714285714286,
    });
  });

  it("counts the whole screen without a picture to measure", () => {
    const whole = { left: 0, top: 0, width: 1280, height: 720 };
    expect(pictureRect(screen, null)).toEqual(whole);
    // Before its metadata loads, a video says it is 0 by 0.
    expect(pictureRect(screen, { width: 0, height: 0 })).toEqual(whole);
  });

  it("is empty while the player is hidden", () => {
    expect(pictureRect({ width: 0, height: 0 }, { width: 1920, height: 1080 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});
