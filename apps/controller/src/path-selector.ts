import type { PathStatus, PathStrategyName } from "@aceswarm/shared/api-types";

/** Exponentially weighted history of how healthy a stream was on each path (0..1). */
export type PathMemory = Map<string, number>;

const UNKNOWN_AFFINITY = 0.5;
const MEMORY_ALPHA = 0.02;

/** Records one health observation of a stream on its current path. */
export function rememberHealth(memory: PathMemory, pathId: string, healthy: boolean): void {
  const previous = memory.get(pathId) ?? UNKNOWN_AFFINITY;
  memory.set(pathId, previous + MEMORY_ALPHA * ((healthy ? 1 : 0) - previous));
}

/** Combined score of a path for one stream: network probes plus the stream's own history. */
export function pathScore(path: PathStatus, memory: PathMemory): number {
  return path.up ? 0.6 * path.score + 0.4 * (memory.get(path.id) ?? UNKNOWN_AFFINITY) : 0;
}

function bestOf(paths: PathStatus[], memory: PathMemory): PathStatus | undefined {
  let best: PathStatus | undefined;
  let bestScore = -1;
  for (const path of paths) {
    const score = pathScore(path, memory);
    // Ties keep the earlier path, so "direct" (listed first) wins when nothing is better.
    if (path.up && score > bestScore) {
      best = path;
      bestScore = score;
    }
  }
  return best;
}

export interface InitialPathInput {
  strategy: PathStrategyName;
  paths: PathStatus[];
  memory: PathMemory;
  /** How many streams currently use each path, used by round robin to spread the load. */
  load: ReadonlyMap<string, number>;
  /** Path stored from a previous run; reused when still available (sticky across restarts). */
  remembered: string | null;
}

/** Picks the path for a stream that is starting. */
export function initialPath(input: InitialPathInput): string | undefined {
  const up = input.paths.filter((path) => path.up);
  const remembered = up.find((path) => path.id === input.remembered);
  if (remembered !== undefined) {
    return remembered.id;
  }
  if (input.strategy === "round-robin") {
    const sorted = up.toSorted((a, b) => (input.load.get(a.id) ?? 0) - (input.load.get(b.id) ?? 0));
    return sorted[0]?.id;
  }
  return bestOf(up, input.memory)?.id;
}

export interface SwitchInput {
  strategy: PathStrategyName;
  paths: PathStatus[];
  memory: PathMemory;
  current: string;
  /** Minimum combined-score advantage required to move (sticky-best only). */
  hysteresis: number;
}

/**
 * Chooses where a failing stream should move. Returns `undefined` when staying is the better
 * option: no other path is up, or (for sticky-best) no path beats the current one by the
 * hysteresis margin. A path that is down is always left if any alternative is up.
 */
export function switchTarget(input: SwitchInput): string | undefined {
  const others = input.paths.filter((path) => path.up && path.id !== input.current);
  if (others.length === 0) {
    return undefined;
  }
  if (input.strategy === "round-robin") {
    const order = input.paths.map((path) => path.id);
    const start = order.indexOf(input.current);
    for (let step = 1; step <= order.length; step += 1) {
      const candidate = input.paths[(start + step) % order.length];
      if (candidate?.up === true && candidate.id !== input.current) {
        return candidate.id;
      }
    }
    return undefined;
  }

  const current = input.paths.find((path) => path.id === input.current);
  const currentDown = current?.up !== true;
  const best = bestOf(others, input.memory);
  if (best === undefined) {
    return undefined;
  }
  if (currentDown) {
    return best.id;
  }
  const advantage = pathScore(best, input.memory) - pathScore(current, input.memory);
  return advantage >= input.hysteresis ? best.id : undefined;
}
