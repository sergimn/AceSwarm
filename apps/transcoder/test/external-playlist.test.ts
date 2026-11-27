import { describe, expect, it } from "vitest";
import {
  ExternalPlaylist,
  KEEP_CHANGES_MS,
  SLATE_AFTER_MS,
  SLATE_MARGIN_MS,
  type Slate,
} from "../src/external-playlist.ts";

/** A slate of three segments of two seconds: a loop of six. */
const SLATE: Slate = {
  directory: "/hls/_slate",
  segments: [0, 1, 2].map((index) => ({ uri: `../slate/seg_00${String(index)}.ts`, duration: 2 })),
};
const STALE_MS = 60_000;

interface Made {
  /** What the playlist lists at `seconds`: `s<n>` a segment of the slate, `g<run>:<n>` one of the stream, `|` a discontinuity. */
  at: (seconds: number) => string;
  /** The playlist's text at `seconds`. */
  text: (seconds: number) => string | undefined;
  /** A segment of the stream comes at `seconds`, from the given ffmpeg run. */
  segment: (seconds: number, run: number, index: number, duration?: number) => void;
  /** How many times the slate took the place of the stream's video. */
  slates: () => number;
}

function make(slate: () => Slate | undefined = () => SLATE, staleAfterMs = STALE_MS, longestSegmentMs = 30_000): Made {
  let slates = 0;
  const playlist = new ExternalPlaylist({
    windowSize: 6,
    staleAfterMs,
    longestSegmentMs,
    slate,
    onSlate: () => {
      slates += 1;
    },
  });
  const text = (seconds: number): string | undefined => playlist.render(seconds * 1000);
  const at = (seconds: number): string =>
    (text(seconds) ?? "")
      .split("\n")
      .filter((line) => line.endsWith(".ts") || line === "#EXT-X-DISCONTINUITY")
      .map((line) =>
        line
          .replace("#EXT-X-DISCONTINUITY", "|")
          .replace(/^\.\.\/slate\/seg_0*(\d+)\.ts$/, "s$1")
          .replace(/^\.\.\/g(\d+)\/full\/seg_0*(\d+)\.ts$/, "g$1:$2"),
      )
      .join(" ");
  const segment = (seconds: number, run: number, index: number, duration = 2): void => {
    const uri = `../g${String(run)}/full/seg_${String(index).padStart(6, "0")}.ts`;
    playlist.add(run, { uri, duration }, seconds * 1000);
  };
  return { at, text, segment, slates: () => slates };
}

const sequences = (text = ""): [media: number, discontinuity: number] => [
  Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1]),
  Number(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(text)?.[1]),
];

interface Entry {
  /** Its place among all the playlist ever listed. */
  index: number;
  uri: string;
  duration: number;
  slate: boolean;
}

/** The segments a playlist's text lists. */
function entriesOf(text = ""): Entry[] {
  const first = sequences(text)[0];
  const listed = text.matchAll(/#EXTINF:([\d.]+),\n(\S+)/g).toArray();
  return listed.map((match, position) => ({
    index: first + position,
    uri: match[2] ?? "",
    duration: Number(match[1]),
    slate: (match[2] ?? "").includes("/slate/"),
  }));
}

/** Numbers between 0 and 1 that are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

interface Arrival {
  /** When the stream's ffmpeg wrote it, and from the test's loop on, when the playlist was told of it. */
  at: number;
  run: number;
  index: number;
  duration: number;
  /** It was written in its own time, two seconds after the one before it: it makes up for nothing. */
  regular: boolean;
}

const uriOf = ({ run, index }: Arrival): string => `../g${String(run)}/full/seg_${String(index).padStart(6, "0")}.ts`;

/**
 * A stream of two-second segments that pauses every so often, for 5.5 to 50 seconds or too briefly
 * for the slate (2 to 4.5), and comes back in one of the ways streams do: with all it missed at
 * once, in two lots (up to two and a half seconds apart) or one segment behind the other; with one
 * segment that spans the pause; just late; or as another ffmpeg run. The segments as its ffmpeg
 * writes them.
 */
function pausingStream(random: () => number, seconds: number): Arrival[] {
  const written: Arrival[] = [];
  let clock = 0;
  let run = 1;
  let index = 0;
  const write = (at: number, duration: number, regular: boolean): void => {
    written.push({ at, run, index, duration, regular });
    index += 1;
  };
  while (clock < seconds) {
    const playing = 3 + Math.floor(random() * 15);
    for (let count = 0; count < playing; count += 1) {
      clock += 2;
      write(clock, 2, true);
    }
    const kind = random();
    const pause = kind < 0.3 ? 2 + random() * 2.5 : kind < 0.8 ? 5.5 + random() * 19.5 : 25 + random() * 25;
    const missed = Math.max(1, Math.floor(pause / 2));
    const how = Math.floor(random() * 6);
    clock += pause;
    switch (how) {
      case 0: {
        for (let count = 0; count < missed; count += 1) {
          write(clock, 2, false);
        }
        break;
      }
      case 1: {
        // Further apart only for the shorter pauses: after a long one, a second lot that comes
        // after the first was listed deletes its files (see the notes' limits).
        const later = clock + 0.3 + random() * (pause > 25 ? 0.6 : 2.2);
        for (let count = 0; count < missed; count += 1) {
          write(count < missed / 2 ? clock : later, 2, false);
        }
        clock = later;
        break;
      }
      case 2: {
        for (let count = 0; count < missed; count += 1) {
          write(clock + count * 0.4, 2, false);
        }
        clock += (missed - 1) * 0.4;
        break;
      }
      case 3: {
        write(clock, pause + 2, false);
        break;
      }
      case 4: {
        run += 1;
        index = 0;
        for (let count = 0; count < 1 + Math.floor(random() * 3); count += 1) {
          write(clock, 2, false);
        }
        break;
      }
      default: {
        // Just late: it goes on where it stopped.
        break;
      }
    }
  }
  return written;
}

/**
 * When the playlist is told of the stream's segments: the pipeline looks for new ones once a
 * second and whenever a player asks, so each is noticed up to a second after it was written, and
 * the ones written between two looks are noticed together. The looks from `after` to the player's
 * request at `now`, the last one. A timer is never on the dot: each look of the pipeline's is up
 * to a twentieth of a second early or late.
 */
function looksUntil(now: number, after: number, phase: number, random: () => number): number[] {
  const looks: number[] = [];
  for (let tick = Math.floor(after - phase) + 1 + phase; tick < now - 0.05; tick += 1) {
    const look = tick + (random() - 0.5) * 0.1;
    if (look > after) {
      looks.push(look);
    }
  }
  return [...looks, now];
}

/** How long the stream's segments wait while the slate shows (`HOLD_MS` in the source), in seconds. */
const HOLD = 1.25;
/** The longest a two-second segment in its own time is noticed after the one before it, in seconds. */
const OWN_TIME_AT_MOST = 3.25;
/** How many of a run's last segments ffmpeg keeps the files of: the six its playlist lists, and four more. */
const FILES_KEPT = 10;

/**
 * A player that asks for the playlist, and checks what it gets against the stream's segments as
 * they came: the playlist's rules (see `Count` and `HOLD_MS` in the source), from the outside.
 */
class Watch {
  /** Times the slate took over from the stream's video. */
  slates = 0;
  private readonly name: string;
  /** The stream's segments as the playlist was told of them, in order, and where each is in that order. */
  private readonly arrivals: Arrival[] = [];
  private readonly orderOf = new Map<string, number>();
  private readonly seen = new Map<number, Entry>();
  /** How many of the stream's segments the playlist is done with: listed, or left out. */
  private settled = 0;
  /** The stream's last segment before the slate that last took over, while the count goes on. */
  private before: { index: number; at: number } | undefined;
  /** When the slate was last listed, or a segment of the stream left out. */
  private brokenAt = 0;

  constructor(name: string) {
    this.name = name;
  }

  /** The player asks at `now`, after the segments in `came`, and gets `listed`. */
  asks(now: number, came: readonly Arrival[], listed: readonly Entry[]): void {
    const where = `${this.name} at ${now.toFixed(1)}`;
    // It asks often enough to see every segment the playlist ever lists.
    expect(listed[0]?.index ?? Infinity, where).toBeLessThanOrEqual(this.seen.size);
    for (const arrival of came) {
      this.orderOf.set(uriOf(arrival), this.arrivals.length);
      this.arrivals.push(arrival);
    }
    for (const entry of listed) {
      if (this.seen.has(entry.index)) {
        continue;
      }
      this.seen.set(entry.index, entry);
      if (entry.slate) {
        this.slate(entry, now);
      } else {
        this.stream(entry, where);
      }
    }
    // Nothing it lists is gone: ffmpeg deletes a run's oldest files as it writes new ones.
    for (const entry of listed) {
      if (entry.slate) {
        continue;
      }
      const [run, index] = (/g(\d+)\/full\/seg_(\d+)/.exec(entry.uri) ?? []).slice(1).map(Number);
      const newestOfRun = this.arrivals.findLast((arrival) => arrival.run === run)?.index ?? NaN;
      expect(index, `${where}: ${entry.uri} is gone`).toBeGreaterThan(newestOfRun - FILES_KEPT);
    }
    const newest = this.arrivals.at(-1);
    // The stream comes back: its newest segment waits no longer than the playlist says.
    if (newest?.regular === true && now - newest.at > HOLD + 1e-6) {
      expect(this.settled, `${where}: ${uriOf(newest)} not listed`).toBe(this.arrivals.length);
    }
    if (this.before === undefined) {
      return;
    }
    let since = 0;
    for (let index = this.before.index + 1; index < this.seen.size; index += 1) {
      since += this.seen.get(index)?.duration ?? NaN;
    }
    expect(since, where).toBeLessThanOrEqual(now - this.before.at + 1 + 1e-6);
  }

  /** A segment of the stream is listed: the ones that came before it and are not listed were left out. */
  private stream(entry: Entry, where: string): void {
    const order = this.orderOf.get(entry.uri) ?? NaN;
    const behindSlate = this.seen.get(entry.index - 1)?.slate === true;
    const first = this.arrivals[this.settled];
    const previous = this.arrivals[this.settled - 1];
    const pausedAgain =
      first !== undefined &&
      previous !== undefined &&
      (first.at - previous.at > OWN_TIME_AT_MOST || first.duration > OWN_TIME_AT_MOST);
    if (!behindSlate && pausedAgain) {
      // The stream paused again after it was back, too briefly for the slate (the segment after the
      // pause came late, or lasts the pause as well): what it delivers now makes up for that, while
      // the player waited. It is the player's to play.
      this.before = undefined;
    }
    for (const leftOut of this.arrivals.slice(this.settled, order)) {
      // What comes in its own time is never left out once the stream is back. Right behind the
      // slate it may be: the slate lasted that much longer, and the stream's video has no gap.
      expect(behindSlate || !leftOut.regular, `${where}: ${uriOf(leftOut)} left out`).toBe(true);
      this.brokenAt = Math.max(this.brokenAt, leftOut.at);
    }
    this.settled = order + 1;
    if ((this.arrivals[order]?.at ?? 0) - this.brokenAt >= 30) {
      // The stream is back for good: what it delivers from here is its own to list.
      this.before = undefined;
    }
  }

  private slate(entry: Entry, now: number): void {
    this.brokenAt = now;
    const last = this.seen.get(entry.index - 1);
    if (last === undefined || last.slate) {
      return;
    }
    this.slates += 1;
    this.before = { index: last.index, at: this.arrivals[this.orderOf.get(last.uri) ?? NaN]?.at ?? NaN };
  }
}

describe("ExternalPlaylist", () => {
  it("starts the slate with three segments at once, then lists one more as each comes due", () => {
    const { at, text } = make();
    // A player that has nothing yet gets a few seconds to play behind the newest segment.
    expect(at(0)).toBe("s0 s1 s2");
    expect(at(1.9)).toBe("s0 s1 s2");
    expect(at(2)).toBe("s0 s1 s2 | s0");
    expect(at(4.5)).toBe("s0 s1 s2 | s0 s1");
    // Asked again at the same moment, it is the same.
    expect(at(4.5)).toBe("s0 s1 s2 | s0 s1");
    expect(text(4.5)).toContain("#EXT-X-TARGETDURATION:2\n");
    expect(text(4.5)).toContain("#EXTINF:2.000,\n../slate/seg_001.ts\n");
  });

  it("starts the slate's loop over behind a discontinuity, and keeps counting", () => {
    const { at, text } = make();
    expect(at(0)).toBe("s0 s1 s2");
    expect(at(2)).toBe("s0 s1 s2 | s0");
    expect(sequences(text(2))).toEqual([0, 0]);
    expect(at(9)).toBe("s1 s2 | s0 s1 s2 | s0");
    expect(sequences(text(9))).toEqual([1, 0]);
    // A discontinuity stays listed for twenty seconds, with the segment before it: the list is
    // longer than six segments meanwhile.
    expect(KEEP_CHANGES_MS).toBe(20_000);
    expect(at(14)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0");
    expect(sequences(text(14))).toEqual([2, 0]);
    expect(at(20)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2 | s0");
    // The one that came at 2 leaves when it is twenty seconds old. A discontinuity that left the
    // list counts in the sequence of discontinuities.
    expect(at(22)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1");
    expect(sequences(text(22))).toEqual([5, 1]);
    // Segments that came due between two requests are all there, in order.
    expect(at(36)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2");
    expect(sequences(text(36))).toEqual([11, 3]);
    expect(at(38)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2 | s0");
  });

  it("goes over to the stream's segments behind a discontinuity", () => {
    const { at, segment, slates } = make();
    expect(at(0)).toBe("s0 s1 s2");
    expect(at(2)).toBe("s0 s1 s2 | s0");
    segment(3, 1, 0);
    expect(at(3)).toBe("s0 s1 s2 | s0 | g1:0");
    segment(5, 1, 1);
    segment(7, 1, 2);
    // No slate while the stream's segments keep coming, and none between two of one ffmpeg run.
    expect(at(8)).toBe("s1 s2 | s0 | g1:0 g1:1 g1:2");
    // The slate a stream starts with is no video lost.
    expect(slates()).toBe(0);
  });

  it("takes the slate again when no segment of the stream came for five seconds, one segment as each comes due", () => {
    const { at, segment, slates } = make();
    expect(at(0)).toBe("s0 s1 s2");
    segment(1, 1, 0);
    segment(3, 1, 1);
    expect(SLATE_AFTER_MS).toBe(5000);
    expect(at(7.9)).toBe("s0 s1 s2 | g1:0 g1:1");
    expect(slates()).toBe(0);
    // One segment, and one more as each comes due: the playlist stays behind the time that passed.
    expect(at(8)).toBe("s0 s1 s2 | g1:0 g1:1 | s0");
    expect(slates()).toBe(1);
    expect(at(9.9)).toBe("s0 s1 s2 | g1:0 g1:1 | s0");
    expect(at(10)).toBe("s1 s2 | g1:0 g1:1 | s0 s1");
    // The stream is back, in the same ffmpeg run: its segments are behind a discontinuity all the
    // same. The first one waits a moment, in case more come right behind it.
    segment(11, 1, 2);
    expect(at(11)).toBe("s1 s2 | g1:0 g1:1 | s0 s1");
    expect(at(12.25)).toBe("s2 | g1:0 g1:1 | s0 s1 | g1:2");
    expect(slates()).toBe(1);
    // Five seconds count from its last segment, each time, and each time counts once.
    segment(13, 1, 3);
    expect(at(17.9)).toBe("s2 | g1:0 g1:1 | s0 s1 | g1:2 g1:3");
    expect(at(18)).toBe("s2 | g1:0 g1:1 | s0 s1 | g1:2 g1:3 | s0");
    expect(slates()).toBe(2);
  });

  it("lists the slate's segments that came due while nobody asked", () => {
    const { at, segment, slates } = make();
    segment(1, 1, 0);
    segment(3, 1, 1);
    // The first was due at 8, and one more every two seconds since.
    expect(at(33)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2 | s0");
    expect(at(35)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1");
    expect(slates()).toBe(1);
  });

  it("puts a segment of the stream that comes as the slate is due before it", () => {
    const { at, segment, slates } = make();
    expect(at(0)).toBe("s0 s1 s2");
    segment(1, 1, 0);
    // Nobody asked between the two: the stream's segment came first, so no slate was due.
    segment(8, 1, 1);
    expect(at(8)).toBe("s0 s1 s2 | g1:0 g1:1");
    expect(slates()).toBe(0);
  });

  it("puts a discontinuity between the segments of two ffmpeg runs", () => {
    const { at, segment } = make();
    segment(1, 1, 7);
    segment(3, 1, 8);
    segment(5, 2, 0);
    segment(7, 2, 1);
    // Nobody asked before the stream had video: there was no one to show the slate to.
    expect(at(7)).toBe("g1:7 g1:8 | g2:0 g2:1");
  });

  it("waits for a stream's long segments as long as they take to come", () => {
    const { at, segment, slates } = make();
    segment(0, 1, 0, 6);
    segment(6, 1, 1, 6);
    // Each comes six seconds after the one before: the slate waits three more than that.
    expect(SLATE_MARGIN_MS).toBe(3000);
    expect(at(14.9)).toBe("g1:0 g1:1");
    expect(at(15)).toBe("g1:0 g1:1 | s0");
    expect(slates()).toBe(1);
    // A short segment after long ones: the next may be long again.
    segment(16, 1, 2, 2);
    expect(at(24.9)).toBe("g1:0 g1:1 | s0 | g1:2");
    expect(at(25)).toBe("g1:0 g1:1 | s0 | g1:2 | s0");
  });

  it("shows no slate between the segments of a broadcast whose key frames are far apart", () => {
    const { at, segment, slates } = make();
    // A segment of twelve seconds every twelve seconds, and a player that asks every two.
    for (let second = 0; second <= 96; second += 2) {
      if (second % 12 === 0) {
        segment(second, 1, second / 12, 12);
      }
      expect(at(second), String(second)).not.toMatch(/s\d/);
    }
    expect(slates()).toBe(0);
    // When it stops, the slate comes three seconds after its next segment was due.
    expect(at(110.9)).not.toMatch(/s\d/);
    expect(at(111)).toMatch(/g1:8 \| s0$/);
    expect(slates()).toBe(1);
  });

  it("comes back in time after an outage, when the stream's first segment is the short end of a long one", () => {
    const { at, segment, slates } = make();
    // Twelve seconds between key frames. The stream stops, and a player asks every two seconds.
    segment(0, 1, 0, 12);
    segment(12, 1, 1, 12);
    segment(24, 1, 2, 12);
    for (let second = 26; second <= 70; second += 2) {
      at(second);
    }
    expect(at(70)).not.toMatch(/g/);
    expect(slates()).toBe(1);
    // It comes back a little before a key frame. The playlist now lists segments of two seconds
    // and this one, so a player waits as it does for a stream of short segments, and the stream's
    // next segment takes eleven seconds.
    segment(71, 1, 3, 1.8);
    expect(at(75.9)).toMatch(/g1:3$/);
    expect(at(76)).toMatch(/g1:3 \| s0$/);
    expect(slates()).toBe(2);
    expect(at(78)).toMatch(/g1:3 \| s0 s1$/);
    expect(at(80)).toMatch(/g1:3 \| s0 s1 s2$/);
    // That segment is no later than this stream's segments are: it is listed, although with the
    // slate's six seconds the playlist then lists more than the eleven that passed.
    segment(82, 1, 4, 12);
    expect(at(83.25)).toMatch(/g1:3 \| s0 s1 s2 \| g1:4$/);
    // With a long segment listed again, the slate waits as it did before the outage.
    segment(94, 1, 5, 12);
    for (let second = 94; second <= 108; second += 2) {
      expect(at(second), String(second)).toMatch(/g1:4 g1:5$/);
    }
    expect(at(109)).toMatch(/g1:5 \| s0$/);
    expect(slates()).toBe(3);
  });

  it("doesn't wait longer after a segment whose time spans an outage", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    // The first one after 40 seconds without data says it lasts that long.
    segment(42, 1, 1, 41.5);
    expect(at(46.9).endsWith("g1:1")).toBe(true);
    expect(at(47).endsWith("g1:1 | s0")).toBe(true);
    // Nor after a second one soon after.
    segment(48, 1, 2);
    segment(75, 1, 3, 26);
    expect(at(79.9).endsWith("g1:3")).toBe(true);
    expect(at(80).endsWith("g1:3 | s0")).toBe(true);
  });

  it("tells a segment that spans an outage from a stream's usual long ones", () => {
    const long = make();
    long.segment(0, 1, 0, 12);
    long.segment(12, 1, 1, 12);
    long.segment(24, 1, 2, 12);
    // After 40 seconds without data: more than twice what its segments usually last.
    long.segment(76, 1, 3, 52);
    expect(long.at(90.9)).toBe("g1:3");
    expect(long.at(91)).toBe("g1:3 | s0");
    // A stream's first segment says what is usual, unless no stream that plays has one that long:
    // a full output that writes none for 30 seconds is started again.
    const first = make();
    first.segment(0, 1, 0, 41.5);
    expect(first.at(4.9)).toBe("g1:0");
    expect(first.at(5)).toBe("g1:0 | s0");
    // Where a full output may take a minute, a broadcast with key frames 40 seconds apart plays.
    const patient = make(() => SLATE, STALE_MS, 60_000);
    patient.segment(0, 1, 0, 40);
    patient.segment(40, 1, 1, 40);
    expect(patient.at(59)).toBe("g1:0 g1:1");
    expect(patient.at(82.9)).toBe("g1:1");
    expect(patient.at(83)).toBe("g1:1 | s0");
  });

  it("takes each ffmpeg run's segments for what they are", () => {
    const { at, segment, slates } = make();
    // A re-encoded run cuts every two seconds; the copy that follows it cuts at the broadcast's
    // key frames, here twelve seconds apart.
    segment(0, 1, 0);
    segment(2, 1, 1);
    segment(4, 1, 2);
    segment(16, 2, 0, 12);
    expect(at(18)).toBe("g1:0 g1:1 g1:2 | g2:0");
    segment(28, 2, 1, 12);
    expect(at(30.9)).toBe("g1:0 g1:1 g1:2 | g2:0 g2:1");
    expect(at(42.9)).toBe("g1:0 g1:1 g1:2 | g2:0 g2:1");
    expect(slates()).toBe(0);
    expect(at(43)).toBe("g1:0 g1:1 g1:2 | g2:0 g2:1 | s0");
  });

  it("lists the stream's segments only while there is no slate, and nothing once they are old", () => {
    // The slate, once ffmpeg has made it.
    const ready: Slate[] = [];
    const { at, text, segment, slates } = make(() => ready[0]);
    expect(text(0)).toBeUndefined();
    expect(text(30)).toBeUndefined();
    segment(31, 1, 0);
    segment(33, 1, 1);
    expect(at(33)).toBe("g1:0 g1:1");
    expect(at(80)).toBe("g1:0 g1:1");
    // As in the page's playlist: video older than the stale threshold is not for a player that opens now.
    expect(text(31 + STALE_MS / 1000 + 0.1)).toContain("g1/full/seg_000001.ts");
    expect(text(31 + STALE_MS / 1000 + 0.1)).not.toContain("g1/full/seg_000000.ts");
    expect(text(33 + STALE_MS / 1000 + 0.1)).toBeUndefined();
    expect(slates()).toBe(0);

    // A slate that is made later shows from then on.
    ready.push(SLATE);
    expect(at(200)).toBe("| s0 s1 s2");
    expect(sequences(text(200))).toEqual([2, 0]);
    expect(slates()).toBe(1);
  });

  it("goes to the slate at once when the stream's last segment got old before its next one was late", () => {
    // A short stale threshold, and segments of eight seconds: the next one is not late for eleven.
    const { at, segment, slates } = make(() => SLATE, 10_000);
    segment(0, 1, 0, 8);
    segment(8, 1, 1, 8);
    expect(at(18)).toBe("g1:1");
    // Nothing is left to list: a playlist without segments would end a player.
    expect(at(18.1)).toBe("| s0 s1 s2");
    expect(slates()).toBe(1);
  });

  it("starts its slate over from now when nobody asked for a long time", () => {
    const { at, text, segment } = make();
    expect(at(0)).toBe("s0 s1 s2");
    segment(1, 1, 0);
    segment(3, 1, 1);
    expect(at(3)).toBe("s0 s1 s2 | g1:0 g1:1");
    // Ten minutes later: the old video is gone, and so are the slate's segments nobody was there
    // for. Whoever asks now has nothing yet, and gets three segments at once.
    expect(at(603)).toBe("| s0 s1 s2");
    expect(sequences(text(603))).toEqual([5, 1]);
    expect(at(606)).toBe("| s0 s1 s2 | s0");
    // Within a minute, the segments that came due meanwhile are all there.
    expect(at(650)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1");
    expect(sequences(text(650))).toEqual([22, 7]);
    // After more than a minute it goes on from now, with three segments again.
    expect(at(800)).toBe("s2 | s0 s1");
    expect(sequences(text(800))).toEqual([31, 10]);
  });

  it("goes on with its slate from now when nobody asked for a minute, before the stream's video got old", () => {
    // A stale threshold of five minutes.
    const { at, text, segment } = make(() => SLATE, 300_000);
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    // Two minutes later, whoever asks has nothing to play: three of the slate's segments, from now.
    expect(at(128)).toBe("g1:0 g1:1 | s0 s1 s2 | s0");
    expect(sequences(text(128))).toEqual([0, 0]);
    // Nothing is counted for that player: the stream's next segment is listed as it comes.
    segment(129, 1, 2);
    expect(at(129)).toBe("g1:1 | s0 s1 s2 | s0 | g1:2");
  });

  it("keeps the stream's segments waiting while the slate shows, until none came for a moment", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    segment(4, 1, 2);
    expect(at(9)).toBe("g1:0 g1:1 g1:2 | s0");
    expect(at(11)).toBe("g1:0 g1:1 g1:2 | s0 s1");
    // The stream is back with the twelve seconds it missed, which its ffmpeg writes within a
    // second, oldest first: the pipeline notices two segments, then two more, then three.
    segment(13.1, 1, 3);
    segment(13.1, 1, 4);
    // The slate goes on meanwhile.
    expect(at(13.1)).toBe("g1:0 g1:1 g1:2 | s0 s1 s2");
    segment(13.5, 1, 5);
    segment(13.5, 1, 6);
    for (const index of [7, 8, 9]) {
      segment(14, 1, index);
    }
    expect(at(14.5)).toBe("g1:0 g1:1 g1:2 | s0 s1 s2");
    expect(at(15.24)).toBe("g1:1 g1:2 | s0 s1 s2 | s0");
    // A second and a quarter after the last ones, no more are on their way. Of all seven, the
    // newest that fits is listed: the files of the oldest are the first that ffmpeg deletes.
    expect(at(15.25)).toBe("g1:2 | s0 s1 s2 | s0 | g1:9");
    // The stream goes on in one piece.
    segment(16, 1, 10);
    segment(18, 1, 11);
    expect(at(18)).toBe("g1:2 | s0 s1 s2 | s0 | g1:9 g1:10 g1:11");
  });

  it("ends the wait with a segment that comes a moment after the ones that wait", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    // Nobody asks meanwhile. The second one comes two seconds after the first: the stream in its
    // own time. Both are looked at as it comes: eight and a half seconds passed, two are listed.
    segment(8.5, 1, 2);
    segment(10.5, 1, 3);
    segment(12.5, 1, 4);
    expect(at(12.5)).toBe("g1:0 g1:1 | s0 | g1:2 g1:3 g1:4");
    // The same with a slate that went on for longer: only the newer one fits, and the stream is
    // back with it.
    const longer = make();
    longer.segment(0, 1, 0);
    longer.segment(2, 1, 1);
    expect(longer.at(8)).toBe("g1:0 g1:1 | s0");
    longer.segment(8.5, 1, 2);
    expect(longer.at(9.7)).toBe("g1:0 g1:1 | s0 s1");
    longer.segment(10.5, 1, 3);
    expect(longer.at(10.5)).toBe("g1:0 g1:1 | s0 s1 | g1:3");
  });

  it("takes the newest segments of the look that ended the wait with the ones that waited", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    // Nobody asks meanwhile. The stream makes up for its pause in two lots, a second and a half
    // apart: the second one ends the wait. Of all seven, the two newest fit.
    for (const index of [2, 3, 4]) {
      segment(9, 1, index);
    }
    for (const index of [5, 6, 7, 8]) {
      segment(10.5, 1, index);
    }
    expect(at(10.5)).toBe("g1:0 g1:1 | s0 | g1:7 g1:8");
  });

  it("ends the wait with each segment of a stream whose segments last a second", () => {
    const { at, segment } = make();
    for (let index = 0; index <= 4; index += 1) {
      segment(index, 1, index, 1);
    }
    expect(at(9)).toBe("g1:0 g1:1 g1:2 g1:3 g1:4 | s0");
    // The stream is back in its own time, and a player asks every half a second: its segments are
    // noticed a second apart, sooner than the wait would end otherwise.
    segment(10, 1, 5, 1);
    expect(at(10.5)).toBe("g1:0 g1:1 g1:2 g1:3 g1:4 | s0");
    segment(11, 1, 6, 1);
    expect(at(11)).toBe("g1:2 g1:3 g1:4 | s0 | g1:5 g1:6");
    segment(12, 1, 7, 1);
    expect(at(12)).toBe("g1:3 g1:4 | s0 | g1:5 g1:6 g1:7");
  });

  it("doesn't keep one ffmpeg run's segments waiting for another's", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    // The run's last segment waits. Half a second later another run's first one comes: the one
    // that waits is looked at, and the slate is over.
    segment(8.5, 1, 2);
    segment(9, 2, 0);
    expect(at(9)).toBe("g1:0 g1:1 | s0 | g1:2 | g2:0");
  });

  it("leaves out what the stream delivers late for the time the slate covered", () => {
    const { at, segment, slates } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    segment(4, 1, 2);
    expect(at(4)).toBe("g1:0 g1:1 g1:2");
    // The stream gets no data for eight seconds, and a player asks every two.
    expect(at(8)).toBe("g1:0 g1:1 g1:2");
    expect(at(10)).toBe("g1:0 g1:1 g1:2 | s0");
    expect(at(12)).toBe("g1:0 g1:1 g1:2 | s0 s1");
    // Then it gets all of it at once, and its ffmpeg writes four segments. With the slate's four
    // seconds, eight more would be twelve in the nine and three quarters that passed since its
    // last segment: every player would be that much further behind from here on. The two newest
    // ones fit, with the second to spare that is asked of video that comes late.
    for (const index of [3, 4, 5, 6]) {
      segment(12.5, 1, index);
    }
    expect(at(13.75)).toBe("g1:1 g1:2 | s0 s1 | g1:5 g1:6");
    // What comes in its own time after that is listed.
    segment(14.5, 1, 7);
    segment(16.5, 1, 8);
    expect(at(16.5)).toBe("g1:2 | s0 s1 | g1:5 g1:6 g1:7 g1:8");
    expect(slates()).toBe(1);
  });

  it("leaves out a segment whose time spans a pause the slate covered", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    segment(4, 1, 2);
    expect(at(4)).toBe("g1:0 g1:1 g1:2");
    expect(at(10)).toBe("g1:0 g1:1 g1:2 | s0");
    expect(at(12)).toBe("g1:0 g1:1 g1:2 | s0 s1");
    // The data of the pause is lost. The first segment after it says it lasts the pause as well:
    // with the slate's seconds that is more than the time that passed. The slate goes on.
    segment(13.5, 1, 3, 9.2);
    expect(at(13.5)).toBe("g1:0 g1:1 g1:2 | s0 s1 s2");
    // The next one comes two seconds later, so no more are on their way with the first. It fits,
    // behind a discontinuity, and before the slate's next segment that was due.
    segment(15.5, 1, 4);
    expect(at(15.5)).toBe("g1:1 g1:2 | s0 s1 s2 | g1:4");
    // The one left out doesn't make the slate wait longer.
    expect(at(20.4)).toBe("g1:1 g1:2 | s0 s1 s2 | g1:4");
    expect(at(20.5)).toBe("g1:2 | s0 s1 s2 | g1:4 | s0");
  });

  it("puts a discontinuity where segments of the stream were left out", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    // The stream is back with what it missed, which its ffmpeg (re-encoding) takes long to write:
    // one segment, and three more when the first one is listed already.
    segment(8.5, 1, 2);
    expect(at(9.75)).toBe("g1:0 g1:1 | s0 | g1:2");
    for (const index of [3, 4, 5]) {
      segment(10.2, 1, index);
    }
    // Eight seconds passed since its last segment before the slate, and four are listed: one fits.
    expect(at(10.2)).toBe("g1:0 g1:1 | s0 | g1:2 | g1:5");
  });

  it("puts a discontinuity where ffmpeg wrote more segments between two looks than its playlist lists", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    // ffmpeg makes up for lost time, and lists six segments in its playlist: the page's playlist
    // never had the two before them.
    for (const index of [4, 5, 6, 7, 8, 9]) {
      segment(3, 1, index);
    }
    expect(at(3)).toBe("g1:1 | g1:4 g1:5 g1:6 g1:7 g1:8 g1:9");
  });

  it("goes to the slate at once when ffmpeg deleted the files of all it lists", () => {
    const { at, text, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    for (const index of [2, 3, 4, 5, 6]) {
      segment(9, 1, index);
    }
    expect(at(10.25)).toBe("g1:0 g1:1 | s0 | g1:5 g1:6");
    // Right after that, the stream makes up for the rest of its pause. None of it fits, and ffmpeg
    // deleted the files of all that is listed: a playlist without segments would end a player.
    for (let index = 7; index <= 18; index += 1) {
      segment(10.5, 1, index);
    }
    expect(at(10.5)).toBe("| s0 s1 s2");
    expect(sequences(text(10.5))).toEqual([5, 2]);
    segment(12.5, 1, 19);
    expect(at(12.5)).toBe("| s0 s1 s2 | g1:19");
  });

  it("lists all the stream delivers after the slate for a player that had nothing", () => {
    const { at, segment, slates } = make();
    expect(at(0)).toBe("s0 s1 s2");
    expect(at(2)).toBe("s0 s1 s2 | s0");
    expect(at(4)).toBe("s0 s1 s2 | s0 s1");
    // Such a player is not behind, so nothing is counted. A stream's first segments, which come
    // right behind each other, are all listed.
    segment(4.2, 1, 0);
    expect(at(4.2)).toBe("s0 s1 s2 | s0 s1 | g1:0");
    segment(4.9, 1, 1);
    segment(5.1, 1, 2);
    expect(at(5.1)).toBe("s2 | s0 s1 | g1:0 g1:1 g1:2");
    segment(6.9, 1, 3);
    expect(at(6.9)).toBe("s2 | s0 s1 | g1:0 g1:1 g1:2 g1:3");
    expect(slates()).toBe(0);
  });

  it("takes a segment that is noticed a second after the one before it for the stream in its own time", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    segment(4, 1, 2);
    expect(at(9)).toBe("g1:0 g1:1 g1:2 | s0");
    expect(at(11)).toBe("g1:0 g1:1 g1:2 | s0 s1");
    // Back with four segments at once. A moment later ten seconds passed and four are listed, so
    // two fit, with the second to spare.
    for (const index of [3, 4, 5, 6]) {
      segment(13, 1, index);
    }
    expect(at(14.25)).toBe("g1:1 g1:2 | s0 s1 | g1:5 g1:6");
    // The stream goes on in its own time. Its next segment is noticed a second after it was
    // written and the one after that at once: a millisecond less than a second apart.
    segment(16, 1, 7);
    segment(16.999, 1, 8);
    expect(at(17)).toBe("g1:2 | s0 s1 | g1:5 g1:6 g1:7 g1:8");
  });

  it("asks a second to spare of a segment that follows the one before it too soon to be in its own time", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    segment(4, 1, 2);
    expect(at(9)).toBe("g1:0 g1:1 g1:2 | s0");
    expect(at(11)).toBe("g1:0 g1:1 g1:2 | s0 s1");
    for (const index of [3, 4, 5, 6]) {
      segment(13.6, 1, index);
    }
    expect(at(14.85)).toBe("g1:1 g1:2 | s0 s1 | g1:5 g1:6");
    // The stream goes on in its own time, two seconds after those.
    segment(15.6, 1, 7);
    // Half a second behind that one, a segment makes up for a pause. Twelve seconds and a tenth
    // passed and ten are listed: it would fit, but not with a second to spare.
    segment(16.1, 1, 8);
    expect(at(16.1)).toBe("g1:2 | s0 s1 | g1:5 g1:6 g1:7");
    // 0.8 seconds after that, a segment may be the stream in its own time (the one before it
    // noticed a second late), and has the benefit of the second: 12.9 passed, ten are listed.
    segment(16.9, 1, 9);
    expect(at(16.9)).toBe("g1:2 | s0 s1 | g1:5 g1:6 g1:7 | g1:9");
    // So does the next one: 13.7 passed, twelve are listed. The one after it doesn't fit, even
    // with the second: 14.5 passed, fourteen are listed.
    segment(17.7, 1, 10);
    segment(18.5, 1, 11);
    expect(at(18.5)).toBe("g1:2 | s0 s1 | g1:5 g1:6 g1:7 | g1:9 g1:10");
    // With the next, ffmpeg deleted the file of the first one listed, ten before it.
    segment(20.5, 1, 12);
    expect(at(20.5)).toBe("s0 s1 | g1:5 g1:6 g1:7 | g1:9 g1:10 | g1:12");
  });

  it("lists all the stream delivers again once its segments came for half a minute", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    expect(at(5)).toBe("g1:0 | s0");
    // Back after six seconds, and one segment every two seconds for half a minute.
    for (let index = 1; index <= 16; index += 1) {
      segment(4 + 2 * index, 1, index);
    }
    expect(at(36)).toBe("g1:11 g1:12 g1:13 g1:14 g1:15 g1:16");
    // Three at once after that are all listed, as in the page's playlist.
    for (const index of [17, 18, 19]) {
      segment(38, 1, index);
    }
    expect(at(38)).toBe("g1:14 g1:15 g1:16 g1:17 g1:18 g1:19");
    // Sooner after the slate, only one of three fits: 22 seconds passed since the stream's last
    // segment before the slate, and 18 are listed. The first two listed left with their files.
    const soon = make();
    soon.segment(0, 1, 0);
    expect(soon.at(5)).toBe("g1:0 | s0");
    for (let index = 1; index <= 8; index += 1) {
      soon.segment(4 + 2 * index, 1, index);
    }
    for (const index of [9, 10, 11]) {
      soon.segment(22, 1, index);
    }
    expect(soon.at(22)).toBe("g1:2 g1:3 g1:4 g1:5 g1:6 g1:7 g1:8 | g1:11");
  });

  it("lists all the stream delivers after a pause too short for the slate, once it is back from one", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(11)).toBe("g1:0 g1:1 | s0 s1 s2");
    for (const index of [2, 3, 4, 5, 6]) {
      segment(12, 1, index);
    }
    expect(at(13.25)).toBe("g1:1 | s0 s1 s2 | g1:5 g1:6");
    segment(14, 1, 7);
    segment(16, 1, 8);
    // The stream pauses again, for less than the slate waits. The data of the pause is lost, and
    // the segment after it lasts that long as well: no slate stood in for it, so it is listed.
    segment(20.4, 1, 9, 5.6);
    expect(at(20.4)).toBe("g1:1 | s0 s1 s2 | g1:5 g1:6 g1:7 g1:8 g1:9");
    segment(22.4, 1, 10);
    expect(at(22.4)).toBe("g1:1 | s0 s1 s2 | g1:5 g1:6 g1:7 g1:8 g1:9 g1:10");
    // So it is when the segment after the pause comes in time, but lasts the pause as well.
    const spans = make();
    spans.segment(0, 1, 0);
    spans.segment(2, 1, 1);
    expect(spans.at(11)).toBe("g1:0 g1:1 | s0 s1 s2");
    for (const index of [2, 3, 4, 5, 6]) {
      spans.segment(12, 1, index);
    }
    spans.segment(14, 1, 7);
    spans.segment(16, 1, 8);
    spans.segment(18.2, 1, 9, 6);
    expect(spans.at(18.2)).toBe("g1:1 | s0 s1 s2 | g1:6 g1:7 g1:8 g1:9");
  });

  it("counts from the stream's last segment each time the slate takes over", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    expect(at(5)).toBe("g1:0 | s0");
    expect(at(7)).toBe("g1:0 | s0 s1");
    // A moment after these three, nine seconds and a quarter passed and four are listed: two fit.
    for (const index of [1, 2, 3]) {
      segment(8, 1, index);
    }
    expect(at(9.25)).toBe("g1:0 | s0 s1 | g1:2 g1:3");
    // The same again, from when the last of them came.
    expect(at(13)).toBe("g1:0 | s0 s1 | g1:2 g1:3 | s0");
    expect(at(15)).toBe("g1:0 | s0 s1 | g1:2 g1:3 | s0 s1");
    for (const index of [4, 5, 6]) {
      segment(16, 1, index);
    }
    expect(at(17.25)).toBe("g1:0 | s0 s1 | g1:2 g1:3 | s0 s1 | g1:5 g1:6");
  });

  it("keeps counting through a slate that shows for longer than half a minute", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    for (let seconds = 2; seconds <= 40; seconds += 2) {
      at(seconds);
    }
    expect(at(40)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2");
    // The stream is back with one segment, which fits, and a moment later with what it missed.
    segment(40.5, 1, 1);
    expect(at(41.75)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2 | g1:1");
    for (const index of [2, 3, 4]) {
      segment(42.5, 1, index);
    }
    expect(at(42.5)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2 | g1:1 | g1:4");
  });

  it("keeps counting for half a minute after the last segment it left out", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(10)).toBe("g1:0 g1:1 | s0 s1");
    for (const index of [2, 3, 4, 5]) {
      segment(10.5, 1, index);
    }
    expect(at(11.75)).toBe("g1:0 g1:1 | s0 s1 | g1:4 g1:5");
    // The stream goes on in its own time, but for a second lot that makes up for its pause.
    let index = 6;
    const ownTime = (from: number, to: number): void => {
      for (let seconds = from; seconds <= to; seconds += 2) {
        segment(seconds, 1, index);
        index += 1;
        at(seconds);
      }
    };
    const lot = (seconds: number): void => {
      for (const end = index + 3; index < end; index += 1) {
        segment(seconds, 1, index);
      }
    };
    ownTime(12.5, 24.5);
    lot(25.5);
    expect(at(25.5)).toBe("g1:6 g1:7 g1:8 g1:9 g1:10 g1:11 g1:12");
    // Thirty seconds after the slate, a third lot is left out as well: the second one was not.
    ownTime(26.5, 40.5);
    lot(41.5);
    expect(at(41.5)).toBe("g1:18 g1:19 g1:20 g1:21 g1:22 g1:23");
  });

  it("takes what fits of another ffmpeg run's first segments after the slate", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(7)).toBe("g1:0 g1:1 | s0");
    expect(at(9)).toBe("g1:0 g1:1 | s0 s1");
    // The run that follows starts with three segments at once. A moment later eight and three
    // quarter seconds passed, and four are listed.
    for (const index of [0, 1, 2]) {
      segment(9.5, 2, index);
    }
    expect(at(10.75)).toBe("g1:0 g1:1 | s0 s1 | g2:2");
  });

  it("never lists more than the time that passed since the stream's last segment before the slate", () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = seeded(seed);
      const { text, segment } = make();
      const written = pausingStream(random, 400);
      const watch = new Watch(`seed ${String(seed)}`);
      const phase = random();
      let next = 0;
      let asked = 0;
      for (let now = 2; now < 400; now += 0.5 + random() * 1.5) {
        const came: Arrival[] = [];
        for (const look of looksUntil(now, asked, phase, random)) {
          for (let one = written[next]; one !== undefined && one.at <= look; one = written[next]) {
            segment(look, one.run, one.index, one.duration);
            came.push({ ...one, at: look });
            next += 1;
          }
        }
        watch.asks(now, came, entriesOf(text(now)));
        asked = now;
      }
      expect(watch.slates, `seed ${String(seed)}: times the slate took over`).toBeGreaterThan(3);
    }
  });

  it("lists nothing more of a slate without segments, or with one that lasts no time", () => {
    const empty = make(() => ({ directory: "/hls/_slate", segments: [] }));
    expect(empty.text(10)).toBeUndefined();
    const broken = make(() => ({ directory: "/hls/_slate", segments: [{ uri: "../slate/seg_000.ts", duration: 0 }] }));
    expect(broken.text(10)).toBeUndefined();
  });

  it("repeats a slate of one segment behind a discontinuity each time", () => {
    const one = make(() => ({ directory: "/hls/_slate", segments: [{ uri: "../slate/seg_000.ts", duration: 2 }] }));
    expect(one.at(0)).toBe("s0 | s0 | s0");
    expect(one.at(2)).toBe("s0 | s0 | s0 | s0");
  });
});
