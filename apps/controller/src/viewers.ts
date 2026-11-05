import type { ViewerView } from "@aceswarm/shared/api-types";

export interface ViewersOptions {
  /** How often players report what they show; a viewer that misses about two reports is gone. */
  pingMs: number;
  /** Viewers kept at most; the one heard from longest ago goes first. */
  maxViewers?: number;
  now?: () => number;
}

interface Viewer {
  stream: string;
  device: string;
  since: number;
  lastSeen: number;
}

/**
 * Who watches which stream full screen, from the players' periodic reports. A viewer is a random
 * id the page makes up when it loads and keeps only in memory, so it lasts one visit: nothing is
 * stored in the browser and nothing identifies the person.
 */
export class Viewers {
  /** How often players report (see `ViewersOptions`). */
  readonly pingMs: number;
  private readonly viewers = new Map<string, Viewer>();
  private readonly timeoutMs: number;
  private readonly maxViewers: number;
  private readonly now: () => number;

  constructor(options: ViewersOptions) {
    this.pingMs = options.pingMs;
    this.timeoutMs = Math.round(options.pingMs * 2.5);
    this.maxViewers = options.maxViewers ?? 200;
    this.now = options.now ?? Date.now;
  }

  /** A player reported what it shows: a stream, or nothing (`null`) once it closed. */
  report(viewer: string, stream: string | null, device: string): void {
    const now = this.now();
    const previous = this.viewers.get(viewer);
    this.viewers.delete(viewer);
    if (stream === null) {
      return;
    }
    this.viewers.set(viewer, {
      stream,
      device,
      since: previous?.stream === stream ? previous.since : now,
      lastSeen: now,
    });
    // Insertion order is report order, so the first entries were heard from longest ago.
    for (const id of this.viewers.keys()) {
      if (this.viewers.size <= this.maxViewers) {
        break;
      }
      this.viewers.delete(id);
    }
  }

  /** Viewers of a stream that went away (it was removed): they stop counting right away. */
  forgetStream(stream: string): void {
    for (const [id, viewer] of this.viewers) {
      if (viewer.stream === stream) {
        this.viewers.delete(id);
      }
    }
  }

  /** Number of viewers watching the stream. */
  count(stream: string): number {
    let count = 0;
    for (const [, viewer] of this.activeEntries()) {
      if (viewer.stream === stream) {
        count += 1;
      }
    }
    return count;
  }

  list(): ViewerView[] {
    return [...this.activeEntries()].map(([id, viewer]) => ({
      viewer: id,
      stream: viewer.stream,
      device: viewer.device,
      since: new Date(viewer.since).toISOString(),
    }));
  }

  /** The viewers heard from recently; forgets the others. */
  private *activeEntries(): Generator<[string, Viewer]> {
    const now = this.now();
    for (const [id, viewer] of this.viewers) {
      if (now - viewer.lastSeen > this.timeoutMs) {
        this.viewers.delete(id);
      } else {
        yield [id, viewer];
      }
    }
  }
}

const BROWSERS: [RegExp, string][] = [
  [/Firefox\//, "Firefox"],
  [/Edg\//, "Edge"],
  [/(?:Chrome|Chromium|CriOS)\//, "Chrome"],
  [/Safari\//, "Safari"],
];

/** First match wins, so TVs (which often say Android or Linux too) come first. */
const SYSTEMS: [RegExp, string][] = [
  [/Android TV|AFT[A-Z]|BRAVIA|SMART-TV|SmartTV|Tizen|Web0S|webOS|GoogleTV|CrKey/i, "TV"],
  [/Android/, "Android"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

/**
 * A rough description of a browser from its User-Agent, such as "Chrome on TV", so a dashboard
 * can tell viewers apart without identifying anyone.
 */
export function describeDevice(userAgent = ""): string {
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "Browser";
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return system === undefined ? browser : `${browser} on ${system}`;
}
