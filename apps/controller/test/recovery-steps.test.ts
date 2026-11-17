import { Registry } from "@prometheus-io/client";
import { expect, test } from "vitest";
import type { EngineSession } from "../src/acestream.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import { RecoverySteps, type PlayedFrom, type RecoveryStep } from "../src/recovery-steps.ts";

const session = (name: string): EngineSession => ({
  playbackUrl: `http://${name}/play`,
  statUrl: `http://${name}/stat`,
  commandUrl: `http://${name}/cmd`,
});

/** Plays from `session`, which its transcoder reads. */
const reading = (from: EngineSession | undefined): PlayedFrom => ({
  session: from,
  pipeline: from === undefined ? undefined : { source: from.playbackUrl },
});

function steps() {
  const registry = new Registry();
  const metrics = new ControllerMetrics(registry, () => ({ streams: [], paths: [] }));
  const counts = async (counter: typeof metrics.recoveries): Promise<Record<string, number>> => {
    const { values } = await counter.get();
    return Object.fromEntries(
      values
        .filter(({ value }) => value > 0)
        .map(({ labels, value }) => [String((labels as Record<string, unknown>)["action"]), value]),
    );
  };
  const stream = { playing: reading(session("first")) };
  const recoverySteps = new RecoverySteps("s1", metrics, () => stream.playing);
  return {
    registry,
    stream,
    steps: recoverySteps,
    /** A step that leaves the stream playing from `to`. */
    works: async (step: RecoveryStep, to: PlayedFrom = reading(session(step))) =>
      recoverySteps.take(step, async () => {
        stream.playing = to;
        await Promise.resolve();
      }),
    /** A step that fails, leaving the stream playing from `to` (where it was, by default). */
    fails: async (step: RecoveryStep, to?: PlayedFrom, handsOverTo?: EngineSession) =>
      expect(
        recoverySteps.take(step, async () => {
          if (handsOverTo !== undefined) {
            recoverySteps.handingOver(handsOverTo);
          }
          stream.playing = to ?? stream.playing;
          await Promise.resolve();
          throw new Error(`${step} failed`);
        }),
      ).rejects.toThrow(`${step} failed`),
    /** The stream moves to `to`, whose video arrived after its move gave up. */
    arrives: (to: EngineSession) => {
      stream.playing = reading(to);
      recoverySteps.arrivedLate(to);
    },
    taken: async () => counts(metrics.recoveries),
    succeeded: async () => counts(metrics.recoveriesSucceeded),
  };
}

test("both counters start at zero for every step, so that a rate sees the first one", async () => {
  const { registry } = steps();
  const scrape = await registry.metrics();
  for (const action of ["restart-pipeline", "restart-engine", "switch-path", "failover"]) {
    expect(scrape).toContain(`aceswarm_stream_recoveries_total{stream="s1",action="${action}"} 0`);
    expect(scrape).toContain(`aceswarm_stream_recoveries_succeeded_total{stream="s1",action="${action}"} 0`);
  }
});

test("a recovery counts once the stream plays, under the last step, and only once", async () => {
  const fake = steps();
  await fake.works("restart-pipeline");
  await fake.works("restart-pipeline");
  await fake.works("restart-engine");
  expect(fake.steps.taken).toBe(3);
  expect(await fake.taken()).toEqual({ "restart-pipeline": 2, "restart-engine": 1 });
  // Steps alone are attempts.
  expect(await fake.succeeded()).toEqual({});

  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-engine": 1 });
  // It keeps playing: nothing more to count.
  fake.steps.played();
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-engine": 1 });
  expect(fake.steps.taken).toBe(3);
});

test("a stream that plays without a step recovered nothing", async () => {
  const fake = steps();
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({});
});

test("a step that fails and leaves the stream on its session leaves the credit with the step before", async () => {
  const fake = steps();
  await fake.works("restart-engine");
  // The move to another path brought no video in time: the stream stays where the restart put it.
  await fake.fails("switch-path");
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-engine": 1 });
  expect(await fake.taken()).toEqual({ "restart-engine": 1, "switch-path": 1 });
});

test("a failed failover of a stream that then plays on by itself recovered nothing", async () => {
  const fake = steps();
  await fake.fails("failover");
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({});
  expect(fake.steps.taken).toBe(1);
});

test("a step that fails after it stopped the stream's session keeps the credit: the next start finishes it", async () => {
  const fake = steps();
  await fake.fails("restart-engine", reading(undefined));
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-engine": 1 });
});

test("a step that opened a session its transcoder couldn't read changed nothing", async () => {
  const fake = steps();
  const old = fake.stream.playing;
  // The transcoder could not start: it still reads the session the step stopped, while its last
  // video lasts.
  await fake.fails("restart-engine", { session: session("unread"), pipeline: old.pipeline });
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({});
});

test("a move that fails after the stream moved counts as the move it was", async () => {
  const fake = steps();
  await fake.works("restart-pipeline");
  // Removing the engine it left failed, say: the stream plays from the new engine's session.
  await fake.fails("switch-path", reading(session("moved")));
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "switch-path": 1 });
});

test("video that arrives late from a failed move's engine gives the credit to that move", async () => {
  const fake = steps();
  const kept = session("kept");
  await fake.works("restart-engine");
  await fake.fails("switch-path", undefined, kept);
  fake.arrives(kept);
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "switch-path": 1 });
});

test("late video goes to the step whose move it was, not to the step that failed last", async () => {
  const fake = steps();
  const standby = session("standby");
  await fake.fails("failover", undefined, standby);
  // The next step fails before it hands anything over (no engine could be created, say).
  await fake.fails("switch-path");
  fake.arrives(standby);
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ failover: 1 });
});

test("a late move that no recovery step started gets no credit", async () => {
  const fake = steps();
  const policyMove = session("policy");
  await fake.fails("switch-path");
  // Moving off a path the policy turned off is no recovery step.
  fake.steps.handingOver(policyMove);
  fake.arrives(policyMove);
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({});
});

test("once the stream plays, late video from a move that gave up counts nothing more", async () => {
  const fake = steps();
  const standby = session("standby");
  await fake.works("restart-engine");
  // The failover gives up after 30 s, while the transcoder waits for the standby a while longer.
  await fake.fails("failover", undefined, standby);
  fake.steps.played();
  fake.arrives(standby);
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-engine": 1 });
});

test("a failover that gave up and then played on by itself counts nothing when its video arrives later", async () => {
  const fake = steps();
  const standby = session("standby");
  await fake.fails("failover", undefined, standby);
  fake.steps.played();
  fake.arrives(standby);
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({});
});

test("each outage counts by itself", async () => {
  const fake = steps();
  await fake.works("restart-pipeline");
  fake.steps.played();
  await fake.works("failover");
  fake.steps.played();
  await fake.works("restart-pipeline");
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-pipeline": 2, failover: 1 });
  expect(fake.steps.taken).toBe(3);
});
