import type { PeerStats, PipelineStatus, StreamView } from "@aceswarm/shared/api-types";
import { describe, expect, it } from "vitest";
import type { EngineStats } from "../src/acestream.ts";
import type { StreamConfig } from "../src/stream-store.ts";
import { newestFrame, streamView, type LiveStream } from "../src/stream-view.ts";

const stream: StreamConfig = {
  id: "s1",
  aceId: "0".repeat(40),
  aceIdKind: "content-id",
  name: "Test",
  enabled: true,
  createdAt: "2026-11-07T15:00:00.000Z",
  path: "direct",
  ownEngine: null,
  session: null,
  lastFrameAt: null,
};

const peers: PeerStats = {
  ip: "172.31.250.130",
  connected: 2,
  active: 2,
  uploading: 1,
  countries: [],
  updatedAt: "2026-11-07T15:00:00.000Z",
};

function pipelineAt(lastFrameAt: string | null): PipelineStatus {
  return {
    id: "s1",
    state: "running",
    source: "http://172.31.250.130:6878/play",
    startedAt: "2026-11-07T15:00:00.000Z",
    lastFrameAt,
    frames: 0,
    fps: null,
    videoCodec: null,
    mode: "copy",
    exitCode: null,
    error: null,
    pendingSource: null,
    liveEdge: null,
  };
}

function live(speedUp: number | undefined, uploading: number | null, pipeline?: PipelineStatus): LiveStream {
  const stats: EngineStats | undefined =
    speedUp === undefined ? undefined : { status: "dl", peers: 2, speedDown: 300, speedUp, downloaded: 0, uploaded: 0 };
  return {
    state: "playing",
    stateSince: 0,
    message: null,
    pipeline,
    stats,
    peers: { ...peers, uploading },
    recoveries: 0,
    engine: undefined,
    standbys: [],
  };
}

describe("streamView", () => {
  it("counts no uploading peers while the engine reports no upload", () => {
    expect(streamView(stream, 0, live(0, 1)).peers.uploading).toBe(0);
    expect(streamView(stream, 0, live(12, 1)).peers.uploading).toBe(1);
    // Without engine stats, the gateway's count stands; without accounting, it stays unknown.
    expect(streamView(stream, 0, live(undefined, 1)).peers.uploading).toBe(1);
    expect(streamView(stream, 0, live(0, null)).peers.uploading).toBeNull();
  });

  it("counts connected peers as the engine does, and none while the engine hasn't answered", () => {
    // The gateway's own count of connections (85) is another measure, however large.
    const gateway = { ...peers, connected: 85 };
    const view = (stats: boolean): StreamView["peers"] =>
      streamView(stream, 0, { ...live(stats ? 12 : undefined, 1), peers: gateway }).peers;
    expect(view(true)).toMatchObject({ connected: 2, active: 2, uploading: 1 });
    expect(view(false)).toMatchObject({ connected: null, active: 2, uploading: 1 });
  });

  it("gives the countries of the engine's sending peers as the gateway counted them", () => {
    const countries = ["ES", "FR", "DE", "NL", "IT"].map((code, index) => ({ code, count: 5 - index }));
    const view = streamView(stream, 0, { ...live(12, 1), peers: { ...peers, countries } });
    expect(view.peers.countries).toEqual(countries);
    expect(streamView(stream, 0, { ...live(12, 1), peers: undefined }).peers.countries).toEqual([]);
  });

  it("says when a stopped stream last had video, and that it is on no path", () => {
    const played = "2026-11-07T15:10:00.000Z";
    // A disabled stream has no supervisor: all there is to show is its stored config.
    const disabled = streamView({ ...stream, enabled: false, lastFrameAt: played }, 0);
    expect(disabled).toMatchObject({ state: "stopped", enabled: false, lastFrameAt: played, path: null });
    expect(streamView({ ...stream, enabled: false }, 0).lastFrameAt).toBeNull();
  });

  it("says when a running stream last had video in any of its sessions", () => {
    const earlier = "2026-11-07T15:10:00.000Z";
    const later = "2026-11-07T15:12:00.000Z";
    const lastFrameAt = (stored: string | null, pipeline?: PipelineStatus): string | null =>
      streamView({ ...stream, lastFrameAt: stored }, 0, live(0, 1, pipeline)).lastFrameAt;
    // A pipeline that just started over has no frame of its own yet, and there may be no pipeline.
    expect(lastFrameAt(earlier, pipelineAt(null))).toBe(earlier);
    expect(lastFrameAt(earlier)).toBe(earlier);
    expect(lastFrameAt(earlier, pipelineAt(later))).toBe(later);
    expect(lastFrameAt(null, pipelineAt(later))).toBe(later);
    // The stored time is the newer one when the pipeline's last frame is from before it was saved.
    expect(lastFrameAt(later, pipelineAt(earlier))).toBe(later);
    // A running stream is on its path.
    expect(streamView(stream, 0, live(0, 1)).path).toBe("direct");
  });
});

describe("newestFrame", () => {
  it("picks the later time, whichever side it is on, and the one there is when one is missing", () => {
    const earlier = "2026-11-07T15:10:00.000Z";
    const later = "2026-11-07T15:12:00.000Z";
    expect(newestFrame(earlier, later)).toBe(later);
    expect(newestFrame(later, earlier)).toBe(later);
    expect(newestFrame(null, earlier)).toBe(earlier);
    expect(newestFrame(earlier, null)).toBe(earlier);
    expect(newestFrame(null, null)).toBeNull();
  });
});
