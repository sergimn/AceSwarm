import type { ConnectionStatus } from "./api.ts";
import { formatLastUpdate } from "./format.ts";

/**
 * After this long without a snapshot, what the page shows is old. The controller sends one every
 * 2 seconds, so this is three missed ones.
 */
export const STALE_AFTER_MS = 6000;

/** What the page needs to tell how old what it shows is. */
export interface PageTime {
  /** The controller's time now: the clock that the times of frames were taken from. */
  now: number;
  /** Nothing heard from the controller for a while, so every figure on the page is old. */
  stale: boolean;
  /** How long since the last snapshot arrived. */
  silentMs: number;
}

/**
 * Tells the controller's time, so that ages are measured against the clock that made the times.
 * The browser's clock can be minutes or hours off (a TV whose time was never set, or a wrong time
 * zone), and an age against it is wrong by the same amount. Every snapshot carries the controller's
 * time; the time since it arrived is measured with a monotonic timer, which no clock setting moves.
 */
export class PageClock {
  private heard: { controllerMs: number; at: number } | undefined;

  /** A snapshot arrived. `at` is `performance.now()` when it did. */
  receive(generatedAt: string, at = performance.now()): void {
    const parsed = Date.parse(generatedAt);
    // A snapshot without a usable time can't say better than the browser's clock.
    this.heard = { controllerMs: Number.isNaN(parsed) ? Date.now() : parsed, at };
  }

  read(at = performance.now()): PageTime {
    if (this.heard === undefined) {
      return { now: Date.now(), stale: false, silentMs: 0 };
    }
    const silentMs = Math.max(0, at - this.heard.at);
    return { now: this.heard.controllerMs + silentMs, stale: silentMs > STALE_AFTER_MS, silentMs };
  }
}

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
};

/** What a page that hears nothing says: the connection is being renewed, and what shown is old. */
export function staleNotice(time: PageTime): string {
  return `${CONNECTION_LABELS.reconnecting} ${formatLastUpdate(time.silentMs)}`;
}

/**
 * What the top bar says of the connection. While nothing arrives it says so whatever the browser
 * thinks of its connection: one that dropped without an error (a lost Wi-Fi) still says it is open.
 */
export function connectionLabel(status: ConnectionStatus, time: PageTime): { text: string; status: ConnectionStatus } {
  return time.stale ? { text: staleNotice(time), status: "reconnecting" } : { text: CONNECTION_LABELS[status], status };
}
