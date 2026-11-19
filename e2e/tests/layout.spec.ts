/**
 * A broadcast that changes its layout mid-stream: its video moves to other PIDs, then to another
 * codec and back, under program tables whose version never changes. ffmpeg stays on the streams
 * it found at its start, so the transcoder follows the tables itself and starts a new ffmpeg run
 * right at the change, on the engine session it has (see docs/architecture.md). The full output
 * is copied while the video is H.264 and re-encoded while it is not, whatever it was before.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { TsTables, videoCodecOfLayout, type Layout } from "../../apps/transcoder/src/ts-tables.ts";
import type { PipelineStatus } from "../../packages/shared/src/api-types.ts";
import {
  addStream,
  pipelineStarts,
  pipelineStatus,
  recoveriesSucceeded,
  resetStack,
  streamById,
  waitForSteadyPlaying,
} from "./helpers.ts";
import { broadcasts, newestSegment, setBroadcastLayout, type Broadcast, type BroadcastLayout } from "./mesh.ts";

test.describe.configure({ mode: "serial" });

/** What the transcoder says the source carries with each layout of the broadcast (see e2e/broadcast.sh). */
const CARRIES: Record<BroadcastLayout, string> = {
  default: "program 1 [256:h264 257:0x0f]",
  moved: "program 1 [211:h264 221:0x0f]",
  hevc: "program 1 [211:hevc 221:0x0f]",
};
/** Longer than the stall window (12 s in the E2E stack): a stall the change caused would show. */
const STEADY_MS = 14_000;

/** What the tests share: the broadcast, its layout now, and the stream that plays it. */
const run: { broadcast?: Broadcast; layout: BroadcastLayout; streamId: string } = { layout: "default", streamId: "" };

test.beforeAll(async ({ request }) => {
  await resetStack(request);
  // The third broadcast, whose input recovery.spec stops and starts too: streams.spec measures
  // how much an engine of the first one uploads, and nothing should have disturbed that one.
  run.broadcast = (await broadcasts(3))[2]!;
});

test.afterAll(async () => {
  if (run.broadcast !== undefined && run.layout !== "default") {
    await setBroadcastLayout(run.broadcast, "default");
  }
});

/** The codec of the video in a segment of the HLS output, from its program tables. */
function videoCodecOf(segment: Buffer): string | undefined {
  const tables = new TsTables();
  let carried: Layout | undefined;
  for (let at = 0; at + 188 <= segment.length; at += 188) {
    carried = tables.packet(segment, at) ?? carried;
  }
  return carried === undefined ? undefined : videoCodecOfLayout(carried);
}

/**
 * Changes the broadcast's layout while the stream plays, and waits until the transcoder follows:
 * with one new ffmpeg run, on the session and the engine it had, and without a recovery step.
 * Returns the pipeline's status once the stream plays steadily again.
 */
async function follows(request: APIRequestContext, next: BroadcastLayout): Promise<PipelineStatus> {
  const { streamId } = run;
  const before = (await streamById(request, streamId))!;
  const pipeline = pipelineStatus(streamId)!;
  const starts = pipelineStarts(streamId);
  const recovered = await recoveriesSucceeded(request, streamId);
  const changedAt = Date.now();

  await setBroadcastLayout(run.broadcast!, next);
  run.layout = next;
  await expect
    .poll(() => pipelineStatus(streamId)?.layout, { timeout: 120_000, intervals: [1000] })
    .toBe(CARRIES[next]);
  const after = await waitForSteadyPlaying(request, streamId, STEADY_MS);
  const status = pipelineStatus(streamId)!;

  // The transcoder started one ffmpeg run for the change, and read on from the session it had.
  expect(pipelineStarts(streamId)).toEqual({ ...starts, layout: (starts["layout"] ?? 0) + 1 });
  expect(status.source).toBe(pipeline.source);
  expect(Date.parse(status.layoutChangedAt ?? "")).toBeGreaterThan(changedAt - 5000);
  // Nothing else moved: the same engine, no recovery step, and video that is new.
  expect(after.engine).toEqual(before.engine);
  expect(after.recoveries).toBe(before.recoveries);
  expect(await recoveriesSucceeded(request, streamId)).toEqual(recovered);
  expect(Date.parse(after.lastFrameAt ?? "")).toBeGreaterThan(changedAt);
  expect(after.liveEdge?.state).toBe("live");
  return status;
}

test("follows a broadcast whose video moves to other PIDs, on the same engine session", async ({ request }) => {
  const stream = await addStream(request, run.broadcast!.infohash, "Layout");
  run.streamId = stream.id;
  await waitForSteadyPlaying(request, stream.id, STEADY_MS);
  expect(pipelineStatus(stream.id)).toMatchObject({
    layout: CARRIES.default,
    layoutChangedAt: null,
    mode: "copy",
    videoCodec: "h264",
  });

  const status = await follows(request, "moved");
  expect(status).toMatchObject({ state: "running", mode: "copy", videoCodec: "h264" });
  expect(videoCodecOf(await newestSegment(request, stream.hls.full))).toBe("h264");
});

test("re-encodes the full output while the broadcast is HEVC, and copies it again once it is H.264", async ({
  request,
}) => {
  const playlist = (await streamById(request, run.streamId))!.hls.full;

  const hevc = await follows(request, "hevc");
  expect(hevc).toMatchObject({ state: "running", mode: "transcode", videoCodec: "hevc" });
  // Browsers get H.264 all the same.
  expect(videoCodecOf(await newestSegment(request, playlist))).toBe("h264");

  // The mode belongs to what the source carries now, not to what the stream once carried.
  const back = await follows(request, "default");
  expect(back).toMatchObject({ state: "running", mode: "copy", videoCodec: "h264" });
  expect(videoCodecOf(await newestSegment(request, playlist))).toBe("h264");
});
