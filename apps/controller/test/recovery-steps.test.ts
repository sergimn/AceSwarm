import { Registry } from "@prometheus-io/client";
import { expect, test } from "vitest";
import type { EngineSession } from "../src/acestream.ts";
import { ControllerMetrics } from "../src/metrics.ts";
import { RecoverySteps } from "../src/recovery-steps.ts";

const session = (name: string): EngineSession => ({
  playbackUrl: `http://${name}/play`,
  statUrl: `http://${name}/stat`,
  commandUrl: `http://${name}/cmd`,
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
  return {
    registry,
    steps: new RecoverySteps("s1", metrics),
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
  const first = session("a");
  fake.steps.took("restart-pipeline", first);
  fake.steps.took("restart-pipeline", session("b"));
  fake.steps.took("restart-engine", session("c"));
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
  const current = session("a");
  fake.steps.took("restart-engine", session("old"));
  // The move to another path brought no video in time: the stream stays where the restart put it.
  fake.steps.took("switch-path", current);
  fake.steps.failed(current);
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-engine": 1 });
  expect(await fake.taken()).toEqual({ "restart-engine": 1, "switch-path": 1 });
});

test("a failed failover of a stream that then plays on by itself recovered nothing", async () => {
  const fake = steps();
  const current = session("a");
  fake.steps.took("failover", current);
  fake.steps.failed(current);
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({});
  expect(fake.steps.taken).toBe(1);
});

test("a step that fails after it stopped the stream's session keeps the credit: the next start finishes it", async () => {
  const fake = steps();
  fake.steps.took("restart-engine", session("a"));
  fake.steps.failed(undefined);
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-engine": 1 });
});

test("a move that fails after the stream moved counts as the move it was", async () => {
  const fake = steps();
  fake.steps.took("restart-pipeline", session("old"));
  fake.steps.took("switch-path", session("a"));
  // Removing the engine it left failed, say: the stream plays from the new engine's session.
  fake.steps.failed(session("b"));
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "switch-path": 1 });
});

test("video that arrives late from a failed move's engine gives the credit back to that move", async () => {
  const fake = steps();
  const current = session("a");
  fake.steps.took("restart-engine", session("old"));
  fake.steps.took("switch-path", current);
  fake.steps.failed(current);
  fake.steps.arrivedLate();
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "switch-path": 1 });
});

test("a later step forgets the move that failed before it", async () => {
  const fake = steps();
  const current = session("a");
  fake.steps.took("switch-path", current);
  fake.steps.failed(current);
  fake.steps.took("restart-engine", current);
  // A move that is no recovery step (off a path the policy turned off) finishes late.
  fake.steps.arrivedLate();
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-engine": 1 });
});

test("a late move that no recovery step started gets no credit", async () => {
  const fake = steps();
  fake.steps.arrivedLate();
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({});
});

test("each outage counts by itself", async () => {
  const fake = steps();
  fake.steps.took("restart-pipeline", session("a"));
  fake.steps.played();
  fake.steps.took("failover", session("b"));
  fake.steps.played();
  fake.steps.took("restart-pipeline", session("c"));
  fake.steps.played();
  expect(await fake.succeeded()).toEqual({ "restart-pipeline": 2, failover: 1 });
  expect(fake.steps.taken).toBe(3);
});
