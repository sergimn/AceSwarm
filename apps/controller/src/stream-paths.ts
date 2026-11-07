import type { PathStatus, PathStrategyName } from "@aceswarm/shared/api-types";
import type { Logger } from "@aceswarm/shared/logger";
import { initialPath, pathScore, rememberHealth, switchTarget, type PathMemory } from "./path-selector.ts";

export interface StreamPathsDeps {
  /** Latest network path status from the gateway (empty when it is unreachable). */
  paths: () => PathStatus[];
  /** Whether the network policy lets engines use a path (the direct path is off with WireGuard only). */
  pathAllowed?: ((path: string) => boolean) | undefined;
  /** Number of running streams per path. */
  pathLoad: () => ReadonlyMap<string, number>;
  strategy: PathStrategyName;
  logger: Logger;
}

/**
 * The network paths one stream may use and its choice among them: the gateway's paths minus the
 * ones the network policy turns off, scored with the stream's own history on each of them.
 */
export class StreamPaths {
  private readonly deps: StreamPathsDeps;
  private readonly memory: PathMemory = new Map();

  constructor(deps: StreamPathsDeps) {
    this.deps = deps;
  }

  /** True once the gateway's paths are known. */
  get known(): boolean {
    return this.deps.paths().length > 0;
  }

  allowed(path: string): boolean {
    return this.deps.pathAllowed?.(path) ?? true;
  }

  /** The gateway's paths that the policy lets the stream use. */
  usable(): PathStatus[] {
    return this.deps.paths().filter((path) => this.allowed(path.id));
  }

  /** The gateway's paths are known, but none that the stream may use is up. */
  noneUsable(): boolean {
    return this.known && this.usable().every((path) => !path.up);
  }

  /** Why the stream waits when `noneUsable()`. */
  waitingMessage(): string {
    const wireguardOnly = this.deps.paths().some((path) => !this.allowed(path.id));
    return wireguardOnly
      ? "WireGuard only is on and no WireGuard path is up; waiting for one"
      : "no network path is up; waiting for one";
  }

  /** Records one health observation of the stream on its current path. */
  remember(path: string, healthy: boolean): void {
    rememberHealth(this.memory, path, healthy);
  }

  /** The gateway has the path (a WireGuard path goes once its profile is removed). */
  exists(path: string): boolean {
    return this.deps.paths().some((candidate) => candidate.id === path);
  }

  /**
   * The paths a stream on `current` keeps standbys on: the other ones it may use that are up, best
   * first (the gateway's probes and the stream's own history on each, as for a path switch).
   */
  standbyCandidates(current: string | null): string[] {
    return this.usable()
      .filter((path) => path.up && path.id !== current)
      .map((path) => ({ id: path.id, score: pathScore(path, this.memory) }))
      .toSorted((a, b) => b.score - a.score)
      .map(({ id }) => id);
  }

  /** The path is down, or gone (its WireGuard profile was removed). */
  isDown(path: string | null): boolean {
    return path !== null && this.known && this.deps.paths().find((candidate) => candidate.id === path)?.up !== true;
  }

  /** Another path the stream may use is up. */
  hasAlternative(current: string | null): boolean {
    return this.usable().some((path) => path.up && path.id !== current);
  }

  /** The stream may leave `current`: another path is up, and it stayed long enough or `current` is down. */
  canSwitch(current: string | null, sinceSwitchMs: number, minDwellMs: number): boolean {
    return this.hasAlternative(current) && (sinceSwitchMs >= minDwellMs || this.isDown(current));
  }

  /**
   * Path for a start attempt. A stream that cannot even start on its path (for example because
   * the direct connection blocks it) tries the next best path every second failed attempt, like
   * the recovery ladder does for a stream that was playing.
   */
  forStart(remembered: string | null, failures: number): string | undefined {
    const preferred = initialPath({
      strategy: this.deps.strategy,
      paths: this.usable(),
      memory: this.memory,
      load: this.deps.pathLoad(),
      remembered,
    });
    if (preferred === undefined || failures < 2 || failures % 2 !== 0) {
      return preferred;
    }
    const alternative = this.switchTarget(preferred);
    if (alternative !== undefined) {
      this.deps.logger.info(
        { from: preferred, to: alternative, failures },
        "stream does not start; trying another path",
      );
    }
    return alternative ?? preferred;
  }

  /** Where a failing stream should move (see `switchTarget`); undefined when no other path is up. */
  switchTarget(current: string): string | undefined {
    return switchTarget({ strategy: this.deps.strategy, paths: this.usable(), memory: this.memory, current });
  }
}

/** A fixed number of slots, taken without waiting: limits how many streams move at once. */
export class MoveSlots {
  private free: number;

  constructor(size: number) {
    this.free = size;
  }

  tryTake(): boolean {
    if (this.free === 0) {
      return false;
    }
    this.free -= 1;
    return true;
  }

  release(): void {
    this.free += 1;
  }
}
