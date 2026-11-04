import { randomBytes } from "node:crypto";
import type { Behavior } from "./behavior.ts";

const SPEED_WINDOW_MS = 5000;

export interface Session {
  id: string;
  contentId: string;
  playerId: string;
  behavior: Behavior;
  createdAt: number;
  bytes: number;
  /** Byte counter samples used to compute the download speed. */
  samples: { at: number; bytes: number }[];
  stalled: boolean;
  stopped: boolean;
  /** Ends any open playback response. */
  onStop: (() => void) | undefined;
}

export interface SessionStats {
  status: "prebuf" | "dl";
  peers: number;
  speed_down: number;
  speed_up: number;
  downloaded: number;
  uploaded: number;
  total_progress: number;
  is_live: number;
  playback_session_id: string;
}

/** Playback sessions, keyed by session ID, as the real engine keeps them per player. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  create(contentId: string, playerId: string, behavior: Behavior): Session {
    // A player that asks again replaces its previous session, like the real engine does.
    for (const existing of this.sessions.values()) {
      if (existing.playerId === playerId && existing.contentId === contentId) {
        this.stop(existing.id);
      }
    }
    const session: Session = {
      id: randomBytes(16).toString("hex"),
      contentId,
      playerId,
      behavior,
      createdAt: this.now(),
      bytes: 0,
      samples: [],
      stalled: false,
      stopped: false,
      onStop: undefined,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session?.stopped === false ? session : undefined;
  }

  stop(id: string): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return false;
    }
    session.stopped = true;
    session.onStop?.();
    this.sessions.delete(id);
    return true;
  }

  stopAll(): void {
    for (const id of this.sessions.keys()) {
      this.stop(id);
    }
  }

  addBytes(session: Session, count: number): void {
    session.bytes += count;
    const now = this.now();
    session.samples.push({ at: now, bytes: session.bytes });
    while (session.samples.length > 1 && (session.samples[0]?.at ?? now) < now - SPEED_WINDOW_MS) {
      session.samples.shift();
    }
  }

  /** Download speed in KB/s over the last few seconds, as the engine reports it. */
  speedKbytes(session: Session): number {
    const first = session.samples[0];
    const last = session.samples.at(-1);
    if (
      session.stalled ||
      first === undefined ||
      last === undefined ||
      last.at === first.at ||
      this.now() - last.at > 2000
    ) {
      return 0;
    }
    return Math.round((last.bytes - first.bytes) / 1024 / ((last.at - first.at) / 1000));
  }

  stats(session: Session, peers: number): SessionStats {
    const delivering = session.bytes > 0 && !session.stalled;
    return {
      status: delivering ? "dl" : "prebuf",
      peers: delivering ? peers : 0,
      speed_down: this.speedKbytes(session),
      speed_up: delivering ? Math.round(this.speedKbytes(session) / 4) : 0,
      downloaded: session.bytes,
      uploaded: Math.round(session.bytes / 4),
      total_progress: 0,
      is_live: 1,
      playback_session_id: session.id,
    };
  }
}
