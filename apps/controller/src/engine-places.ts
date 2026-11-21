import type { StreamView } from "@aceswarm/shared/api-types";

/**
 * What an engine container is for right now:
 * - playing: the engine a stream plays from, whether or not video arrives.
 * - standby: a hot standby of a stream on another path.
 * - kept: the engine of a failed move, kept to try the move again.
 * - starting: a new engine of a stream that has no place yet, such as the one a start or a move
 *   brings up.
 * - shared: a network path's engine, which every stream on the path plays from.
 * - other: an engine of a stream that has had no place for longer than a start or a handover
 *   takes, such as one a failed removal left behind.
 */
export type EngineRole = "playing" | "standby" | "kept" | "starting" | "shared" | "other";

/** The place an engine has: what it is for, and the network path it is on ("" while unknown). */
export interface EnginePlace {
  role: EngineRole;
  path: string;
}

/** An engine that a stream kept after a failed move, by container name, with the path it is on. */
export interface KeptEngine {
  engine: string;
  path: string;
}

/** An engine container: its name, and its path when it is a shared engine (see `EngineMemory`). */
interface Engine {
  engine: string;
  sharedPath: string | null;
}

/**
 * How long an engine of a stream keeps the place it last had while it has none: a standby taken
 * for a failover is in no list until the handover is over, and the engine a stream left has none
 * until it became a standby or was removed. A new engine is `starting` for as long: a move's engine
 * has to answer, open a session and deliver video first. The longest of these take about five
 * minutes.
 */
export const PLACE_HOLD_MS = 5 * 60_000;

/**
 * How long `placeOf` still knows an engine that left the containers there are: an engine that is
 * stopping or restarting can be out of a sample or two before the sampler sees that it exited.
 */
export const LEFT_HOLD_MS = 60_000;

const NO_PLACE: EnginePlace = { role: "other", path: "" };

/**
 * Works out each engine container's place. A shared engine is its path's from its first moment to
 * its last, which its container says. An engine of a stream changes its place: its container's name
 * changes with every new engine, and a failover swaps the roles of two containers. So theirs come
 * from what the controller knows at that moment: the engine each stream plays from and its standbys
 * (the same view the UI gets), and the engines kept after a failed move. The metrics label engines
 * with their place, which stays from one engine to the next.
 */
export class EnginePlaces {
  private readonly kept: () => KeptEngine[];
  private readonly now: () => number;
  /** The place each stream's engine last had (`starting` for one that never had any), and when. */
  private readonly last = new Map<string, { place: EnginePlace; at: number }>();
  /** The engines that left the containers there are: the place each had then, and when it left. */
  private readonly left = new Map<string, { place: EnginePlace; at: number }>();

  constructor(kept: () => KeptEngine[], now: () => number = Date.now) {
    this.kept = kept;
    this.now = now;
  }

  /**
   * The place of each of these engines, in their order. They have to be all the engine containers
   * there are, because the ones left out are forgotten: a new engine with the name of one that
   * went starts over. Only `placeOf` knows them for a little longer.
   */
  resolve(engines: readonly Engine[], streams: readonly StreamView[]): EnginePlace[] {
    const current = this.current(streams);
    const now = this.now();
    const places = engines.map(({ engine, sharedPath }) =>
      sharedPath === null
        ? this.ofStream(engine, current.get(engine), now)
        : { role: "shared" as const, path: sharedPath },
    );
    const names = new Set(engines.map(({ engine }) => engine));
    for (const [name, last] of this.last) {
      if (!names.has(name)) {
        this.last.delete(name);
        this.left.set(name, { place: now - last.at <= PLACE_HOLD_MS ? last.place : NO_PLACE, at: now });
      }
    }
    for (const [name, { at }] of this.left) {
      // Back, or a new engine with its name: `last` knows that one.
      if (names.has(name) || now - at > LEFT_HOLD_MS) {
        this.left.delete(name);
      }
    }
    return places;
  }

  /**
   * The place a stream's engine had when `resolve` last saw it, or the one it had before that
   * while that is recent: what an engine that is being restarted or removed was for. That also
   * holds for a short while after the engine left the containers `resolve` gets, which a stopping
   * or restarting engine does before its exit shows. Undefined for an engine that `resolve` never
   * saw, such as one that lasted less than the time between two runs.
   */
  placeOf(engine: string): EnginePlace | undefined {
    const now = this.now();
    const last = this.last.get(engine);
    if (last !== undefined) {
      return now - last.at <= PLACE_HOLD_MS ? last.place : NO_PLACE;
    }
    const left = this.left.get(engine);
    return left !== undefined && now - left.at <= LEFT_HOLD_MS ? left.place : undefined;
  }

  /** The streams' engines that have a place right now, by container name. A stronger role replaces a weaker one. */
  private current(streams: readonly StreamView[]): Map<string, EnginePlace> {
    const places = new Map<string, EnginePlace>();
    for (const { engine, path } of this.kept()) {
      places.set(engine, { role: "kept", path });
    }
    for (const stream of streams) {
      for (const standby of stream.standbys) {
        if (standby.engine?.shared === false) {
          places.set(standby.engine.name, { role: "standby", path: standby.path });
        }
      }
    }
    for (const stream of streams) {
      if (stream.engine?.shared === false) {
        places.set(stream.engine.name, { role: "playing", path: stream.path ?? "" });
      }
    }
    return places;
  }

  /** The place of a stream's engine: the one it has, or the one it last had while that is recent. */
  private ofStream(engine: string, place: EnginePlace | undefined, now: number): EnginePlace {
    if (place !== undefined) {
      this.last.set(engine, { place, at: now });
      return place;
    }
    let last = this.last.get(engine);
    if (last === undefined) {
      last = { place: { role: "starting", path: "" }, at: now };
      this.last.set(engine, last);
    }
    return now - last.at <= PLACE_HOLD_MS ? last.place : NO_PLACE;
  }
}
