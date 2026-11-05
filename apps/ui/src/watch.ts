import { api } from "./api.ts";

/**
 * A random id for this page load. It lives only in memory and is never stored (no cookies, no
 * storage), so every visit is a new viewer. `crypto.getRandomValues` works on plain HTTP, unlike
 * `crypto.randomUUID`.
 */
function throwawayId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Tells the controller which stream this page shows full screen, so it knows which streams are
 * being watched: right away when the player opens or closes, and again every `viewerPingSeconds`
 * while it stays open. A hidden page (another tab, a TV app in the background) counts as not
 * watching.
 */
export class WatchReporter {
  private readonly viewer = throwawayId();
  private stream: string | null = null;
  /** What the controller was told last. */
  private reported: string | null = null;
  private intervalMs = 60_000;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    document.addEventListener("visibilitychange", () => {
      this.send(false);
    });
    window.addEventListener("pagehide", () => {
      if (this.reported === null) {
        return;
      }
      api.leaveViewer(this.viewer);
      this.reported = null;
    });
  }

  /** How often to repeat the report, as the controller asks. */
  setInterval(seconds: number): void {
    const intervalMs = Math.max(5, seconds) * 1000;
    if (intervalMs === this.intervalMs) {
      return;
    }
    this.intervalMs = intervalMs;
    this.schedule();
  }

  /** The stream the player shows full screen, or `null` once it closed. */
  show(stream: string | null): void {
    this.stream = stream;
    this.send(true);
    this.schedule();
  }

  private schedule(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.stream !== null) {
      this.timer = setInterval(() => {
        this.send(false);
      }, this.intervalMs);
    }
  }

  /** Reports what the page shows. Repeats a report only while a stream shows (the heartbeat). */
  private send(changed: boolean): void {
    const showing = document.visibilityState === "hidden" ? null : this.stream;
    if (showing === null && this.reported === null && !changed) {
      return;
    }
    this.reported = showing;
    void api.reportViewer(this.viewer, showing).catch(() => undefined);
  }
}
