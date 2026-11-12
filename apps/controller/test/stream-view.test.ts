import type { PeerStats } from "@aceswarm/shared/api-types";
import { describe, expect, it } from "vitest";
import type { EngineStats } from "../src/acestream.ts";
import type { StreamConfig } from "../src/stream-store.ts";
import { streamView, type LiveStream } from "../src/stream-view.ts";

const stream: StreamConfig = {
  id: "s1",
  aceId: "0".repeat(40),
  aceIdKind: "content-id",
  name: "Test",
  enabled: true,
  createdAt: "2026-11-07T15:00:00.000Z",
  path: "direct",
  ownEngine: null,
};

const peers: PeerStats = {
  ip: "172.31.250.130",
  connected: 2,
  active: 2,
  uploading: 1,
  countries: [],
  updatedAt: "2026-11-07T15:00:00.000Z",
};

function live(speedUp: number | undefined, uploading: number | null): LiveStream {
  const stats: EngineStats | undefined =
    speedUp === undefined ? undefined : { status: "dl", peers: 2, speedDown: 300, speedUp, downloaded: 0, uploaded: 0 };
  return {
    state: "playing",
    stateSince: 0,
    message: null,
    pipeline: undefined,
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
});
