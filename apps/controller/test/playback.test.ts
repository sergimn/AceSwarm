import type { PipelineStatus } from "@aceswarm/shared/api-types";
import { describe, expect, test } from "vitest";
import type { TranscoderClient } from "../src/clients.ts";
import { SourceExitedError, waitForHandover } from "../src/playback.ts";

const source = "http://172.31.250.11:6878/play";

const running: PipelineStatus = {
  id: "s1",
  state: "running",
  source,
  startedAt: new Date(0).toISOString(),
  lastFrameAt: null,
  frames: 0,
  fps: null,
  videoCodec: null,
  mode: "copy",
  exitCode: null,
  error: null,
  pendingSource: null,
  liveEdge: null,
};

/** Waits for a handover to `source` while the transcoder answers with `answers`, one per check. */
function waitWith(answers: PipelineStatus[]): Promise<PipelineStatus> {
  const clock = { now: 0 };
  const transcoder = {
    status: () => Promise.resolve(answers.shift() ?? running),
  } as unknown as TranscoderClient;
  return waitForHandover(transcoder, "s1", source, {
    timeoutMs: 120_000,
    pollMs: 1000,
    now: () => clock.now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
}

describe("waitForHandover", () => {
  test("gives up once the new source's ffmpeg exited", async () => {
    const exited = { ...running, state: "exited" as const };
    await expect(waitWith([running, exited, exited])).rejects.toThrow(SourceExitedError);
  });

  test("goes on waiting through a moment's exit, as when the transcoder relaunches it", async () => {
    const exited = { ...running, state: "exited" as const };
    const video = { ...running, lastFrameAt: new Date(5000).toISOString() };
    await expect(waitWith([exited, running, video])).resolves.toEqual(video);
  });

  test("waits the whole timeout for a source that is still read", async () => {
    await expect(waitWith([])).rejects.toThrow("did not deliver video in time");
  });
});
