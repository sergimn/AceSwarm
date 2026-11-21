import type { StreamView } from "@aceswarm/shared/api-types";

/**
 * What an engine container is for right now:
 * - playing: the engine a stream plays from, whether or not video arrives.
 * - standby: a hot standby of a stream on another path.
 * - kept: the engine of a failed move, kept to try the move again.
 * - starting: a new engine that has no place yet, such as the one a start or a move brings up.
 * - shared: a network path's engine, which every stream on the path plays from.
 * - other: an engine of a stream that has had no place for longer than a start or a handover
 *   takes, such as one a failed removal left behind.
 */
export type EngineRole = "playing" | "standby" | "kept" | "starting" | "shared" | "other";

/** The place an engine has: what it is for, and the network path it is on ("" while unknown). */
export interface EngineSlot {
  role: EngineRole;
  path: string;
}

/** An engine container by name, with the network path it is on. */
export interface EnginePath {
  engine: string;
  path: string;
}

export interface EngineSlotSources {
  /** The engines kept to retry a move. */
  kept: () => EnginePath[];
  /** The shared engines. */
  shared: () => EnginePath[];
  now?: () => number;
}

/**
 * How long an engine keeps the place it last had while it has none: a standby taken for a failover
 * is in no list until the handover is over, and the engine a stream left has none until it became a
 * standby or was removed. A new engine is `starting` for as long: a move's engine has to answer,
 * open a session and deliver video first. The longest of these take about five minutes.
 */
export const SLOT_HOLD_MS = 5 * 60_000;

const NO_PLACE: EngineSlot = { role: "other", path: "" };

/**
 * Works out each engine container's place from what the controller knows: the engine each stream
 * plays from and its standbys (the same view the UI gets), the engines kept after a failed move,
 * and the shared engines. Container names change with every new engine, and an engine changes its
 * role when a stream fails over to its standby, so the metrics label engines with their place,
 * which stays.
 */
export class EngineSlots {
  private readonly sources: EngineSlotSources;
  /** The place each engine last had (`starting` for one that never had any), and when. */
  private readonly last = new Map<string, { slot: EngineSlot; at: number }>();

  constructor(sources: EngineSlotSources) {
    this.sources = sources;
  }

  /**
   * The place of each of these engines, in their order. They have to be all the engine containers
   * there are, because the ones left out are forgotten. An engine without a stream is a shared one.
   */
  resolve(engines: readonly { engine: string; stream: string }[], streams: readonly StreamView[]): EngineSlot[] {
    const current = this.current(streams);
    const now = (this.sources.now ?? Date.now)();
    const slots = engines.map(({ engine, stream }) => this.place(engine, stream === "", current.get(engine), now));
    const names = new Set(engines.map(({ engine }) => engine));
    for (const name of this.last.keys()) {
      if (!names.has(name)) {
        this.last.delete(name);
      }
    }
    return slots;
  }

  /** The engines that have a place right now, by container name. A stronger role replaces a weaker one. */
  private current(streams: readonly StreamView[]): Map<string, EngineSlot> {
    const slots = new Map<string, EngineSlot>();
    for (const { engine, path } of this.sources.kept()) {
      slots.set(engine, { role: "kept", path });
    }
    for (const stream of streams) {
      for (const standby of stream.standbys) {
        if (standby.engine?.shared === false) {
          slots.set(standby.engine.name, { role: "standby", path: standby.path });
        }
      }
    }
    for (const stream of streams) {
      if (stream.engine?.shared === false) {
        slots.set(stream.engine.name, { role: "playing", path: stream.path ?? "" });
      }
    }
    for (const { engine, path } of this.sources.shared()) {
      slots.set(engine, { role: "shared", path });
    }
    return slots;
  }

  private place(engine: string, shared: boolean, slot: EngineSlot | undefined, now: number): EngineSlot {
    if (slot !== undefined) {
      this.last.set(engine, { slot, at: now });
      return slot;
    }
    let last = this.last.get(engine);
    if (last === undefined) {
      last = { slot: { role: shared ? "shared" : "starting", path: "" }, at: now };
      this.last.set(engine, last);
    }
    // A shared engine stays its path's whatever happens to it: only its path can be unknown.
    return shared || now - last.at <= SLOT_HOLD_MS ? last.slot : NO_PLACE;
  }
}
