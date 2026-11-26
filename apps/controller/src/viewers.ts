import { createHash, randomBytes } from "node:crypto";
import type { ViewerView } from "@aceswarm/shared/api-types";

export interface ViewersOptions {
  /** How often players report what they show; a viewer that misses about two reports is gone. */
  pingMs: number;
  /**
   * How long a player outside the page counts after its last request for the playlist. It asks
   * again every few seconds while it plays, so this is many requests long.
   */
  externalTimeoutMs?: number;
  /** Viewers kept at most; the one heard from longest ago goes first. */
  maxViewers?: number;
  now?: () => number;
  /** Makes up the id of a player outside the page: random, as the ones the pages make up. */
  newId?: () => string;
}

interface Viewer {
  stream: string;
  device: string;
  since: number;
  lastSeen: number;
  /** How long it counts after it was last heard from. */
  timeoutMs: number;
  /** Only a player outside the page: what tells it from the other players (see `Viewers.poll`). */
  key?: string;
}

/**
 * Who watches which stream.
 *
 * A page says so itself, in periodic reports, while it shows the stream full screen. Its viewer is
 * a random id the page makes up when it loads and keeps only in memory, so it lasts one visit:
 * nothing is stored in the browser and nothing identifies the person.
 *
 * A player outside the page, such as VLC, reports nothing: its requests for the playlist count
 * (see `poll`).
 */
export class Viewers {
  /** How often players report (see `ViewersOptions`). */
  readonly pingMs: number;
  private readonly viewers = new Map<string, Viewer>();
  /** The viewer id of each player outside the page, by its key. */
  private readonly external = new Map<string, string>();
  private readonly timeoutMs: number;
  private readonly externalTimeoutMs: number;
  private readonly maxViewers: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  /** New at every start, so that a key says nothing outside this run. */
  private readonly salt = randomBytes(16);

  constructor(options: ViewersOptions) {
    this.pingMs = options.pingMs;
    this.timeoutMs = Math.round(options.pingMs * 2.5);
    this.externalTimeoutMs = options.externalTimeoutMs ?? 30_000;
    this.maxViewers = options.maxViewers ?? 200;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomBytes(8).toString("hex"));
  }

  /** A player reported what it shows: a stream, or nothing (`null`) once it closed. */
  report(viewer: string, stream: string | null, device: string): void {
    if (stream === null) {
      this.remove(viewer);
      return;
    }
    this.put(viewer, { stream, device, timeoutMs: this.timeoutMs });
  }

  /**
   * A player outside the page asked for the stream's playlist, which it does every few seconds
   * while it plays. The same player is whoever asks for the same stream from the same address with
   * the same User-Agent: two alike behind one address count once. Address and User-Agent are kept
   * only as a hash, in memory, salted anew at every start, and the viewer gets a random id as a
   * page's does: neither the id nor a metric says where a player is.
   */
  poll(stream: string, address: string, userAgent = ""): void {
    const key = createHash("sha256")
      .update(this.salt)
      .update(JSON.stringify([stream, address, userAgent]))
      .digest("base64");
    const known = this.external.get(key);
    const previous = known === undefined ? undefined : this.viewers.get(known);
    // One that stopped asking for longer than it counts is a new viewer when it comes back, and so
    // is one whose id a page's report took meanwhile.
    const same = previous?.key === key && this.now() - previous.lastSeen <= previous.timeoutMs;
    const viewer = known !== undefined && same ? known : this.newId();
    this.put(viewer, { stream, device: describePlayer(userAgent), timeoutMs: this.externalTimeoutMs, key });
  }

  /** Viewers of a stream that went away (it was removed): they stop counting right away. */
  forgetStream(stream: string): void {
    for (const [id, viewer] of this.viewers) {
      if (viewer.stream === stream) {
        this.remove(id);
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

  /** Notes that the viewer was heard from just now. It keeps the time it started on the stream. */
  private put(id: string, heard: Pick<Viewer, "stream" | "device" | "timeoutMs" | "key">): void {
    const now = this.now();
    const previous = this.viewers.get(id);
    this.remove(id);
    this.viewers.set(id, { ...heard, since: previous?.stream === heard.stream ? previous.since : now, lastSeen: now });
    if (heard.key !== undefined) {
      this.external.set(heard.key, id);
    }
    // Insertion order is the order they were heard from, so the first entries are the oldest.
    for (const oldest of this.viewers.keys()) {
      if (this.viewers.size <= this.maxViewers) {
        break;
      }
      this.remove(oldest);
    }
  }

  private remove(id: string): void {
    const key = this.viewers.get(id)?.key;
    this.viewers.delete(id);
    if (key !== undefined && this.external.get(key) === id) {
      this.external.delete(key);
    }
  }

  /** The viewers heard from recently; forgets the others. */
  private *activeEntries(): Generator<[string, Viewer]> {
    const now = this.now();
    for (const [id, viewer] of this.viewers) {
      if (now - viewer.lastSeen > viewer.timeoutMs) {
        this.remove(id);
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

/**
 * Players outside the page, by what they call themselves: VLC says "VLC/3.0.20 LibVLC/3.0.20",
 * Kodi "Kodi/21.0 (...)", apps built on ExoPlayer "ExoPlayerLib/2.19.1" or "AndroidXMedia3/1.4.1",
 * mpv "libmpv" (older ones "mpv 0.32.0"), and ffmpeg, ffplay and what is built on their library
 * "Lavf/61.7.100".
 */
const PLAYERS: [RegExp, string][] = [
  [/\bVLC\//, "VLC"],
  [/\bKodi\//, "Kodi"],
  [/ExoPlayerLib\/|AndroidXMedia3\//, "ExoPlayer"],
  [/\blibmpv\b|\bmpv[ /]/, "mpv"],
  [/\bLavf\//, "ffmpeg"],
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

function describe(names: [RegExp, string][], fallback: string, userAgent: string): string {
  const name = names.find(([pattern]) => pattern.test(userAgent))?.[1] ?? fallback;
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return system === undefined ? name : `${name} on ${system}`;
}

/**
 * A rough description of a browser from its User-Agent, such as "Chrome on TV", so a dashboard
 * can tell viewers apart without identifying anyone.
 */
export function describeDevice(userAgent = ""): string {
  return describe(BROWSERS, "Browser", userAgent);
}

/**
 * The same for a player outside the page, such as "VLC" or "Kodi on Android": most say no more
 * than their name. A browser that plays the playlist by itself is named as a browser, and one
 * that says nothing known is an "External player".
 */
export function describePlayer(userAgent = ""): string {
  return describe([...PLAYERS, ...BROWSERS], "External player", userAgent);
}
