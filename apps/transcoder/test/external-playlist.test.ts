import { describe, expect, it, vi } from "vitest";
import {
  ExternalPlaylist,
  KEEP_CHANGES_MS,
  SLATE_AFTER_MS,
  SLATE_MARGIN_MS,
  steadyNow,
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
  /** It was written in its own time, as long after the one before it as it lasts: it makes up for nothing. */
  regular: boolean;
}

const uriOf = ({ run, index }: Arrival): string => `../g${String(run)}/full/seg_${String(index).padStart(6, "0")}.ts`;

/** How long after its time ffmpeg writes a segment at most: the data that ends it comes in pieces. */
const WRITE_JITTER = 0.7;

/**
 * A stream that pauses every so often, for 5.5 to 50 seconds or too briefly for the slate (2 to
 * 4.5), and comes back in one of the ways streams do: with all it missed at once, in two lots (up to
 * two and a half seconds apart) or one segment behind the other; with one segment that spans the
 * pause; just late; as another ffmpeg run; or making up for the pause at 1.2 to 2.5 times real time
 * until it has, and now and then at 1.05 to 1.2 (within 200 seconds). Its segments last two
 * seconds, or, as a copy cut at a broadcast's key frames, 1.5 to 2.5. The segments as its ffmpeg
 * writes them, each up to `WRITE_JITTER` after its time.
 */
function pausingStream(random: () => number, seconds: number): Arrival[] {
  const written: Arrival[] = [];
  const keyFrames = random() < 0.5;
  const length = (): number => (keyFrames ? 1.5 + Math.round(random() * 10) / 10 : 2);
  let clock = 0;
  let run = 1;
  let index = 0;
  const write = (at: number, duration: number, regular: boolean): void => {
    written.push({ at: at + (regular ? random() * WRITE_JITTER : 0), run, index, duration, regular });
    index += 1;
  };
  while (clock < seconds) {
    const playing = 3 + Math.floor(random() * 15);
    for (let count = 0; count < playing; count += 1) {
      const duration = length();
      clock += duration;
      write(clock, duration, true);
    }
    const kind = random();
    const pause = kind < 0.3 ? 2 + random() * 2.5 : kind < 0.8 ? 5.5 + random() * 19.5 : 25 + random() * 25;
    const missed = Math.max(1, Math.floor(pause / 2));
    const how = Math.floor(random() * 7);
    clock += pause;
    switch (how) {
      case 0: {
        for (let count = 0; count < missed; count += 1) {
          write(clock, length(), false);
        }
        break;
      }
      case 1: {
        const later = clock + 0.3 + random() * 2.2;
        for (let count = 0; count < missed; count += 1) {
          write(count < missed / 2 ? clock : later, length(), false);
        }
        clock = later;
        break;
      }
      case 2: {
        for (let count = 0; count < missed; count += 1) {
          write(clock + count * 0.4, length(), false);
        }
        clock += (missed - 1) * 0.4;
        break;
      }
      case 3: {
        // ffmpeg writes it when its own two seconds of video are there.
        clock += 2;
        write(clock, pause + 2, false);
        break;
      }
      case 4: {
        run += 1;
        index = 0;
        for (let count = 0; count < 1 + Math.floor(random() * 3); count += 1) {
          write(clock, length(), false);
        }
        break;
      }
      case 5: {
        // Just late: it goes on where it stopped.
        break;
      }
      default: {
        // It makes up for the pause at `rate` times real time: at 1.05 to 1.2 now and then, else at
        // 1.2 to 2.5, and within 200 seconds. Each segment takes that much less to come than it
        // lasts, until it is no more behind. Half the time, where that takes long, it pauses again
        // 20 to 80 seconds in, and then makes up for both pauses.
        const drawn = random();
        const rate = Math.max(drawn < 0.15 ? 1.05 + drawn : 1.2 + ((drawn - 0.15) * 1.3) / 0.85, 1 + pause / 200);
        let again = random() < 0.5 ? 20 + random() * 60 : Infinity;
        for (let behind = pause, spent = 0; behind > 0;) {
          if (spent >= again) {
            const more = 5.5 + random() * 5;
            clock += more;
            behind += more;
            again = Infinity;
          }
          const duration = length();
          // The last one ends where the stream is live: it comes no sooner than that.
          const gained = Math.min(duration - duration / rate, behind);
          clock += duration - gained;
          spent += duration - gained;
          behind -= gained;
          write(clock, duration, false);
        }
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

/** How far off its time a segment can be noticed, all told (`NOTICE_SLACK_MS` in the source), in seconds. */
const NOTICE_SLACK = 2;
/**
 * The longest the slate shows once the stream's segments come in their own time, in seconds: until
 * ten seconds of them came (`PACE_SPAN_MS` in the source) and the next one, noticed that late, and
 * one more, in case the slate stood in for all the time that passed and the one before doesn't fit.
 */
const WAITS_AT_MOST = 10 + 2 * (2.5 + NOTICE_SLACK);
/** How many of a run's last segments ffmpeg keeps the files of: the six its playlist lists, and four more. */
const FILES_KEPT = 10;
/** A file a playlist lists is there for this long at least, in seconds: VLC asks for the second segment behind a discontinuity some ten seconds after the first. */
const FILE_LIFE = 12;

/**
 * How long each of the random test's streams lasts, in seconds: long enough for a few pauses after
 * one that the stream makes up for slowly, and pauses again meanwhile, which can take five minutes.
 */
const RANDOM_STREAM_SECONDS = 900;
/** How long the random test may take: 150 streams of fifteen minutes take about a second here, and a few on a slow CI runner. */
const LONG_TEST_MS = 30_000;

/** How long after the stream delivered faster than in real time a segment in its own time may be left out, in seconds. */
const FAST_SPAN = 30;

/**
 * When a stream's segments of two seconds are written, 60 of them or `segments`: in their own time
 * until 20, then none from 21 to 41 (the engine sends nothing), then what it missed at `rate` times
 * real time, and then in real time again. And when it is no longer behind (`done`). With `again`,
 * the engine sends nothing for a while once more, from `again.at`, and then goes on at `rate`.
 */
function catchingUp(
  rate: number,
  segments = 60,
  again?: { at: number; lasting: number },
): { writes: number[]; done: number } {
  const writes: number[] = [];
  let done = Infinity;
  for (let index = 0; index < segments; index += 1) {
    const end = 2 * (index + 1);
    const made = end <= 21 ? end : 41 + (end - 21) / rate;
    const sent = again === undefined || made < again.at ? made : made + again.lasting;
    writes.push(Math.max(sent, end));
    if (sent <= end && end > 21) {
      done = Math.min(done, end);
    }
  }
  return { writes, done };
}

/**
 * Notes in `listedAt` when each entry of `listed` was first listed, at `now`, and returns `now` if
 * one of the stream's segments is listed for the first time right behind the slate after `after`.
 */
function firstListed(listed: readonly Entry[], now: number, listedAt: Map<string, number>, after: number): number {
  let back = Infinity;
  for (const [position, entry] of listed.entries()) {
    if (listedAt.has(entry.uri)) {
      continue;
    }
    listedAt.set(entry.uri, now);
    if (!entry.slate && listed[position - 1]?.slate === true && now > after) {
      back = now;
    }
  }
  return back;
}

/**
 * A stream of two-second segments stops at 2, and at 23 sends what it missed but its last `late`
 * seconds at once: ffmpeg writes more than its playlist lists, and the pipeline sees the newest six.
 * Then it goes on in its own time, that late, while a player asks every half a second, and at 120.5
 * it sends those seconds too, and more, at once. What the playlist lists then. With `again`, it
 * pauses once more from 60 to 68, and then sends what it missed of that at once.
 */
function backlog(late: number, again = false): string {
  const { at, segment } = make();
  segment(0, 1, 0);
  segment(2, 1, 1);
  let index = Math.floor((23 - late) / 2) - 6;
  for (let now = 2.5; now <= 120; now += 0.5) {
    for (; now >= 23 && !(again && now >= 60 && now < 68) && 2 * (index + 1) + late <= now; index += 1) {
      segment(now, 1, index);
    }
    at(now);
  }
  for (const end = index + 3; index < end; index += 1) {
    segment(120.5, 1, index);
  }
  return at(120.5);
}

/**
 * Notes in `durations` how long each entry of `listed` lasts, by its place among all the playlist
 * ever listed, and returns the place of the one whose address ends with `name`, if it is listed.
 */
function placeOf(listed: readonly Entry[], durations: Map<number, number>, name: string): number | undefined {
  let place: number | undefined;
  for (const entry of listed) {
    durations.set(entry.index, entry.duration);
    place = entry.uri.endsWith(name) ? entry.index : place;
  }
  return place;
}

/**
 * Plays a stream whose segments are written at `writes` (see `catchingUp`) until `until`: the
 * pipeline looks once a second, at `phase`, and when a player asks, every two seconds. Each is of
 * the ffmpeg run in `runs` (all of the first where it has none), whose segments are numbered from
 * its first. How much more than the time that passed the playlist listed at most since each of the
 * stream's segments in `after` (its last before a pause), and when each file it listed was first
 * listed.
 */
function playedSlowly(
  writes: readonly number[],
  phase: number,
  after: readonly number[],
  until: number,
  runs: readonly number[] = [],
): { most: number[]; listedAt: Map<string, number>; at: (seconds: number) => string; segment: Made["segment"] } {
  const { at, text, segment } = make();
  const fileOf = (write: number): [run: number, index: number] => {
    const run = runs[write] ?? 1;
    return [run, write - Math.max(0, runs.indexOf(run))];
  };
  let next = 0;
  const came = after.map(() => NaN);
  const places = after.map(() => NaN);
  const most = after.map(() => -Infinity);
  const listedAt = new Map<string, number>();
  const durations = new Map<number, number>();
  for (let now = 1; now <= until; now += 0.25) {
    const asks = now % 2 === 0;
    if (!asks && !Number.isSafeInteger(now - phase)) {
      continue;
    }
    for (; writes[next] !== undefined && (writes[next] ?? 0) <= now; next += 1) {
      segment(now, ...fileOf(next));
      const which = after.indexOf(next);
      if (which !== -1) {
        came[which] = now;
      }
    }
    if (!asks) {
      continue;
    }
    const listed = entriesOf(text(now));
    firstListed(listed, now, listedAt, 0);
    for (const [which, index] of after.entries()) {
      const [run, number] = fileOf(index);
      const name = `g${String(run)}/full/seg_${String(number).padStart(6, "0")}.ts`;
      places[which] = placeOf(listed, durations, name) ?? places[which] ?? NaN;
      // What it listed since then, against the time that passed.
      const since = [...durations]
        .filter(([place]) => place > (places[which] ?? NaN))
        .reduce((sum, [, one]) => sum + one, 0);
      most[which] = Number.isFinite(places[which])
        ? Math.max(most[which] ?? -Infinity, since - (now - (came[which] ?? NaN)))
        : (most[which] ?? -Infinity);
    }
  }
  return { most, listedAt, at, segment };
}

/** How long the files of the stream's segments that were listed at `listedAt` were there at least, written at `writes`. */
function shortestLife(writes: readonly number[], listedAt: ReadonlyMap<string, number>): number {
  let shortest = Infinity;
  for (const [uri, listed] of listedAt) {
    const index = Number(/g1\/full\/seg_(\d+)/.exec(uri)?.[1] ?? NaN);
    // ffmpeg deletes a segment's file when it writes the tenth newer one.
    shortest = Math.min(shortest, (writes[index + 10] ?? Infinity) - listed);
  }
  return shortest;
}

/**
 * A player that asks for the playlist, and checks what it gets against the stream's segments as
 * they came: the playlist's rules (see `Count` and `waitIsOver` in the source), from the outside.
 */
class Watch {
  /** Times the slate took over from the stream's video. */
  slates = 0;
  private readonly name: string;
  /** When the stream's ffmpeg wrote each of its segments, by its address. */
  private readonly writtenAt = new Map<string, number>();
  /** The number of each ffmpeg run's newest segment that came. */
  private readonly newestOfRun = new Map<number, number>();
  /** The stream's segments as the playlist was told of them, in order, and where each is in that order. */
  private readonly arrivals: Arrival[] = [];
  private readonly orderOf = new Map<string, number>();
  private readonly seen = new Map<number, Entry>();
  /** How many of the stream's segments the playlist is done with: listed, or left out. */
  private settled = 0;
  /** The stream's last segment before the slate that last took over, until the stream is back for good in its own time. */
  private before: { index: number; at: number } | undefined;
  /** When the slate was last listed, or a segment of the stream left out. */
  private brokenAt = 0;
  /** When the stream's segments started to come in their own time, one after the other, this time. */
  private regularSince = Infinity;
  /** When the stream last delivered faster than in real time once it was back from the slate. */
  private fastAt = -Infinity;

  constructor(name: string, written: readonly Arrival[]) {
    this.name = name;
    for (const one of written) {
      this.writtenAt.set(uriOf(one), one.at);
    }
  }

  /** The player asks at `now`, after the segments in `came`, and gets `listed`. */
  asks(now: number, came: readonly Arrival[], listed: readonly Entry[]): void {
    const where = `${this.name} at ${now.toFixed(1)}`;
    // It asks often enough to see every segment the playlist ever lists.
    // (Each check runs its expect only when it fails: there are a million of them.)
    if (!((listed[0]?.index ?? Infinity) <= this.seen.size)) {
      expect(listed[0]?.index ?? Infinity, where).toBeLessThanOrEqual(this.seen.size);
    }
    this.came(came, listed.length > 0 && this.seen.get(this.seen.size - 1)?.slate === false);
    for (const entry of listed) {
      if (this.seen.has(entry.index)) {
        continue;
      }
      this.seen.set(entry.index, entry);
      if (entry.slate) {
        this.slate(entry, now);
      } else {
        this.stream(entry, where, now);
      }
    }
    this.filesThere(listed, where);
    this.noneWaits(listed, where, now);
    if (this.before === undefined) {
      return;
    }
    let since = 0;
    for (let index = this.before.index + 1; index < this.seen.size; index += 1) {
      since += this.seen.get(index)?.duration ?? NaN;
    }
    if (!(since <= now - this.before.at + 2 * NOTICE_SLACK + 1e-6)) {
      expect(since, where).toBeLessThanOrEqual(now - this.before.at + 2 * NOTICE_SLACK + 1e-6);
    }
  }

  /** The playlist was told of the segments in `came`, while it showed the stream or not. */
  private came(came: readonly Arrival[], showing: boolean): void {
    for (const arrival of came) {
      const previous = this.arrivals.at(-1);
      const follows =
        previous?.run === arrival.run &&
        previous.index + 1 === arrival.index &&
        arrival.at - previous.at <= arrival.duration + NOTICE_SLACK;
      if (!arrival.regular) {
        this.regularSince = Infinity;
        if (showing) {
          this.fastAt = arrival.at;
        }
      } else if (!follows || this.regularSince === Infinity) {
        this.regularSince = arrival.at;
      }
      this.orderOf.set(uriOf(arrival), this.arrivals.length);
      this.arrivals.push(arrival);
      this.newestOfRun.set(arrival.run, arrival.index);
    }
  }

  /** Nothing it lists is gone: ffmpeg deletes a run's oldest files as it writes new ones. */
  private filesThere(listed: readonly Entry[], where: string): void {
    for (const entry of listed) {
      if (entry.slate) {
        continue;
      }
      const [run, index] = (/g(\d+)\/full\/seg_(\d+)/.exec(entry.uri) ?? []).slice(1).map(Number);
      const newest = this.newestOfRun.get(run ?? NaN) ?? NaN;
      if (!((index ?? NaN) > newest - FILES_KEPT)) {
        expect(index, `${where}: ${entry.uri} is gone`).toBeGreaterThan(newest - FILES_KEPT);
      }
    }
  }

  /** The stream's segments wait to be listed only while the slate shows, and not for long. */
  private noneWaits(listed: readonly Entry[], where: string, now: number): void {
    const newest = this.arrivals.at(-1);
    if (newest === undefined) {
      return;
    }
    const waiting = this.settled !== this.arrivals.length;
    if (waiting && listed.at(-1)?.slate === false && newest.regular && newest.at - this.fastAt > FAST_SPAN) {
      // While the stream shows, the playlist lists its segments as a player asks.
      expect(this.settled, `${where}: ${uriOf(newest)} waits`).toBe(this.arrivals.length);
    }
    // While the slate shows, they wait, but not once they came in their own time for a while, and still do.
    if (
      waiting &&
      listed.at(-1)?.slate === true &&
      now - this.regularSince > WAITS_AT_MOST &&
      now - newest.at <= 2.5 + NOTICE_SLACK
    ) {
      expect(this.settled, `${where}: the stream came in its own time since ${this.regularSince.toFixed(1)}`).toBe(
        this.arrivals.length,
      );
    }
  }

  /** A segment of the stream is listed: the ones that came before it and are not listed were left out. */
  private stream(entry: Entry, where: string, now: number): void {
    const order = this.orderOf.get(entry.uri) ?? NaN;
    const arrival = this.arrivals[order];
    const behindSlate = this.seen.get(entry.index - 1)?.slate === true;
    if (this.before !== undefined && !behindSlate && order === this.settled) {
      // While the count runs, the file of what it lists is there long enough for any player to get
      // it. A player gets the first one behind a discontinuity at once. (Without a count the playlist
      // lists what ffmpeg writes, as the page's does, and its files are as long there.)
      const newer =
        arrival === undefined
          ? undefined
          : this.writtenAt.get(uriOf({ ...arrival, index: arrival.index + FILES_KEPT }));
      if (!((newer ?? Infinity) - now >= FILE_LIFE)) {
        expect((newer ?? Infinity) - now, `${where}: ${entry.uri} is gone too soon`).toBeGreaterThanOrEqual(FILE_LIFE);
      }
    }
    for (const leftOut of this.arrivals.slice(this.settled, order)) {
      // What comes in its own time is never left out once the stream is back. Right behind the
      // slate it may be: the slate lasted that much longer, and the stream's video has no gap. And
      // a few seconds after the stream delivered faster than in real time, which used up what the
      // count had to spare (see the notes' limits).
      const fast = leftOut.at - this.fastAt <= FAST_SPAN;
      if (!behindSlate && !fast && leftOut.regular) {
        expect.fail(`${where}: ${uriOf(leftOut)} left out`);
      }
      this.brokenAt = Math.max(this.brokenAt, leftOut.at);
    }
    this.settled = order + 1;
    if (arrival?.regular === true && arrival.at - this.brokenAt >= 30) {
      // The stream is back for good, in its own time: what it delivers from here is its own to list.
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
    // The stream is back, in the same ffmpeg run, with the eight seconds it missed: its segments
    // are behind a discontinuity all the same. The newest is listed (see the tests of the count).
    for (const index of [2, 3, 4, 5]) {
      segment(11, 1, index);
    }
    expect(at(11)).toBe("s2 | g1:0 g1:1 | s0 s1 | g1:5");
    expect(slates()).toBe(1);
    // Five seconds count from its last segment, each time, and each time counts once.
    segment(13, 1, 6);
    expect(at(17.9)).toBe("s2 | g1:0 g1:1 | s0 s1 | g1:5 g1:6");
    expect(at(18)).toBe("s2 | g1:0 g1:1 | s0 s1 | g1:5 g1:6 | s0");
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
    // The stream is back with what it missed, and the newest fits: a short segment after long
    // ones. The next may be long again.
    segment(16, 1, 2, 6);
    segment(16, 1, 3, 2);
    expect(at(16)).toBe("g1:0 g1:1 | s0 | g1:3");
    expect(at(24.9)).toBe("g1:0 g1:1 | s0 | g1:3");
    expect(at(25)).toBe("g1:0 g1:1 | s0 | g1:3 | s0");
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
    // It comes back with what it missed, which ends a little before a key frame: the newest
    // segment that fits is that short end. The playlist now lists segments of two seconds and this
    // one, so a player waits as it does for a stream of short segments, and the stream's next
    // segment takes eleven seconds.
    for (const index of [3, 4, 5]) {
      segment(71, 1, index, 12);
    }
    segment(71, 1, 6, 1.8);
    expect(at(71)).toMatch(/s\d \| g1:6$/);
    expect(at(75.9)).toMatch(/g1:6$/);
    expect(at(76)).toMatch(/g1:6 \| s0$/);
    expect(slates()).toBe(2);
    expect(at(78)).toMatch(/g1:6 \| s0 s1$/);
    expect(at(80)).toMatch(/g1:6 \| s0 s1 s2$/);
    // That segment is no later than this stream's segments are: it is listed, although with the
    // slate's six seconds the playlist then lists more than the eleven that passed.
    segment(82, 1, 7, 12);
    expect(at(82)).toMatch(/g1:6 \| s0 s1 s2 \| g1:7$/);
    // With a long segment listed again, the slate waits as it did before the outage.
    segment(94, 1, 8, 12);
    for (let second = 94; second <= 108; second += 2) {
      expect(at(second), String(second)).toMatch(/g1:7 g1:8$/);
    }
    expect(at(109)).toMatch(/g1:8 \| s0$/);
    expect(slates()).toBe(3);
  });

  it("lists another ffmpeg run's first segment after an outage only where it fits", () => {
    const { at, segment } = make();
    segment(0, 1, 0, 12);
    segment(12, 1, 1, 12);
    segment(24, 1, 2, 12);
    for (let second = 26; second <= 70; second += 2) {
      at(second);
    }
    for (const index of [3, 4, 5]) {
      segment(71, 1, index, 12);
    }
    segment(71, 1, 6, 1.8);
    for (let second = 72; second <= 80; second += 2) {
      at(second);
    }
    expect(at(80)).toMatch(/g1:6 \| s0 s1 s2$/);
    // Where the stream's next segment would be on time, another ffmpeg run's first one comes: it
    // says nothing of when this run's segments come, and doesn't fit.
    segment(82, 2, 0, 12);
    expect(at(82)).toMatch(/g1:6 \| s0 s1 s2 \| s0$/);
  });

  it("doesn't wait longer after a segment whose time spans an outage", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    // The first one after 40 seconds without data says it lasts that long (a jump in its timestamps).
    segment(42, 1, 1, 41.5);
    expect(at(46.9).endsWith("g1:1")).toBe(true);
    expect(at(47).endsWith("g1:1 | s0")).toBe(true);
    // Nor after a second one soon after, once the stream was back from the slate.
    for (const index of [2, 3, 4]) {
      segment(48, 1, index);
    }
    expect(at(48).endsWith("s0 | g1:4")).toBe(true);
    segment(75, 1, 5, 26);
    expect(at(79.9).endsWith("g1:5")).toBe(true);
    expect(at(80).endsWith("g1:5 | s0")).toBe(true);
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

  it("never lists the stream's last segment once it is old, though nobody asked since it came", () => {
    const { at, text, segment, slates } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    // The stream stops, and the first player asks after more than a minute: its last segment waited
    // to be looked at with the next one, and is as old as the one before it. The engine's run may
    // be gone with its files by now.
    expect(text(70)).not.toContain("g1/full");
    expect(at(70)).toBe("| s0 s1 s2");
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

  it("leaves out the segments that waited when a player asks after a minute without requests", () => {
    const { at, text, segment } = make();
    for (let index = 0; index < 10; index += 1) {
      segment(2 * index + 2, 1, index);
      at(2 * index + 2);
    }
    // The stream stops at 20, and a player watches the slate until 40.
    for (let now = 21; now <= 40; now += 2) {
      at(now);
    }
    expect(at(40)).toBe("g1:9 | s0 s1 s2 | s0 s1 s2 | s0 s1");
    // Then the stream comes back at 0.4 times real time, which never ends the wait, and nobody asks.
    let index = 10;
    for (let now = 45; now <= 160; now += 5) {
      segment(now, 1, index);
      index += 1;
    }
    // A player that asks now has nothing: it gets three of the slate's segments, and the stream's
    // next one after them. The ones that waited are old, and the oldest about to go.
    expect(at(160.5)).toBe("s2 | s0 s1");
    segment(161, 1, index);
    expect(at(161)).toBe("s2 | s0 s1 | g1:34");
    expect(text(161)).toContain("#EXT-X-MEDIA-SEQUENCE:18\n");
  });

  it("keeps the stream's segments waiting while the slate shows, until it made up for what it missed", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    segment(4, 1, 2);
    expect(at(9)).toBe("g1:0 g1:1 g1:2 | s0");
    expect(at(11)).toBe("g1:0 g1:1 g1:2 | s0 s1");
    // The stream is back with the ten seconds it missed, which its ffmpeg writes within a second,
    // oldest first: the pipeline notices one segment, then one more, then three. The slate goes on
    // meanwhile.
    segment(13.1, 1, 3);
    expect(at(13.1)).toBe("g1:0 g1:1 g1:2 | s0 s1 s2");
    segment(13.5, 1, 4);
    expect(at(13.5)).toBe("g1:0 g1:1 g1:2 | s0 s1 s2");
    for (const index of [5, 6, 7]) {
      segment(14, 1, index);
    }
    // As much of its video came as time passed since its last segment before the slate, give or
    // take two seconds. Of all five, the newest that fits is listed: the files of the oldest are
    // the first that ffmpeg deletes.
    expect(at(14)).toBe("g1:1 g1:2 | s0 s1 s2 | g1:7");
    // The stream goes on in one piece.
    segment(16, 1, 8);
    segment(18, 1, 9);
    expect(at(18)).toBe("g1:2 | s0 s1 s2 | g1:7 g1:8 g1:9");
  });

  it("takes the newest segments of the look that ended the wait with the ones that waited", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    // Nobody asks meanwhile. The stream makes up for its pause in two lots, a second and a half
    // apart: the second one ends the wait. Of all five, the two newest fit.
    for (const index of [2, 3]) {
      segment(9, 1, index);
    }
    for (const index of [4, 5, 6]) {
      segment(10.5, 1, index);
    }
    expect(at(10.5)).toBe("g1:0 g1:1 | s0 | g1:5 g1:6");
  });

  it("ends the wait once the stream came in its own time for ten seconds, however far behind", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    // The stream goes on where it stopped, six seconds late, and a player asks every two seconds.
    // It never makes up for that, and the slate goes on until ten seconds of its video came in
    // ten seconds.
    for (let index = 2; index <= 6; index += 1) {
      segment(8.5 + 2 * (index - 2), 1, index);
      expect(at(9 + 2 * (index - 2))).toMatch(/s\d$/);
    }
    expect(at(18)).toMatch(/s\d$/);
    segment(18.5, 1, 7);
    // The slate stood in for the time that passed: the newest segment fits, with two seconds to
    // spare for the ones that follow.
    expect(at(19)).toMatch(/s\d \| g1:7$/);
    segment(20.5, 1, 8);
    segment(22.5, 1, 9);
    expect(at(23)).toMatch(/s\d \| g1:7 g1:8 g1:9$/);
    // So with segments of a second, which the pipeline notices a second apart.
    const short = make();
    for (let index = 0; index <= 4; index += 1) {
      short.segment(index, 1, index, 1);
    }
    expect(short.at(9)).toBe("g1:0 g1:1 g1:2 g1:3 g1:4 | s0");
    for (let index = 5; index <= 16; index += 1) {
      short.segment(index + 5, 1, index, 1);
      // The slate goes on until ten seconds of the stream's video came in ten seconds, at 20.
      expect(short.at(index + 5.5)).toMatch(index + 5 < 20 ? /s\d$/ : /g1:\d+$/);
    }
    expect(short.at(21)).toMatch(/s\d \| g1:14 g1:15 g1:16$/);
  });

  it("gives way to a stream that came back in its own time wherever its segments fall between the slate's", () => {
    for (const late of [6.5, 7, 7.25, 7.5, 7.75, 8, 8.5]) {
      const { at, segment } = make();
      segment(0, 1, 0);
      segment(2, 1, 1);
      // The stream goes on where it stopped, `late` seconds after its last segment, and a player
      // asks every half a second. Where none of the segments that waited fits with two seconds to
      // spare, they are left out, and the next one, on time after the newest of them, is listed.
      let back = Infinity;
      for (let now = 2.25; now <= 60; now += 0.25) {
        if (now >= 2 + late && (now - 2 - late) % 2 === 0) {
          segment(now, 1, (now - 2 - late) / 2 + 2);
        }
        if (now % 0.5 === 0 && back === Infinity && /s\d+ \| g1:\d+$/.test(at(now))) {
          back = now;
        }
      }
      expect(back - (2 + late), String(late)).toBeLessThanOrEqual(13);
      expect(at(60).split(" | ").at(-1), String(late)).toMatch(/^g1:\d+( g1:\d+){5}$/);
    }
  });

  it("shows the slate while the stream comes slower than in real time, and gives way once it comes in its own time", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    // For two minutes, two segments every eight seconds: half as fast as real time. The stream
    // never makes up for its pause, nor comes in its own time.
    let index = 2;
    for (let now = 2.5; now <= 130; now += 0.5) {
      if (now >= 10 && now % 8 === 2) {
        segment(now, 1, index);
        segment(now, 1, index + 1);
        index += 2;
      }
      const listed = at(now);
      if (now >= 10) {
        expect(listed, String(now)).toMatch(/s\d+$/);
      }
    }
    // Then it does, and the slate gives way within twenty seconds, to the stream in one piece.
    let back = Infinity;
    for (let now = 130.5; now <= 200; now += 0.5) {
      if (now % 2 === 0) {
        segment(now, 1, index);
        index += 1;
      }
      if (back === Infinity && !/s\d+$/.test(at(now))) {
        back = now;
      }
    }
    expect(back).toBeLessThanOrEqual(150);
    expect(at(200).split(" | ").at(-1)).toMatch(/^g1:\d+( g1:\d+){5}$/);
  });

  it("keeps the stream's segments waiting while it makes up for a pause faster than in real time", () => {
    for (const rate of [1.5, 2, 3]) {
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        const where = `${String(rate)}x, looks at ${String(phase)}`;
        const { at, text, segment } = make();
        const { writes, done } = catchingUp(rate);
        // The pipeline looks once a second and when a player asks, every two seconds.
        let next = 0;
        const listedAt = new Map<string, number>();
        let back = Infinity;
        for (let now = 1; now <= 110; now += 0.25) {
          const asks = now % 2 === 0;
          if (!asks && !Number.isSafeInteger(now - phase)) {
            continue;
          }
          for (; writes[next] !== undefined && (writes[next] ?? 0) <= now; next += 1) {
            segment(now, 1, next);
          }
          if (asks) {
            const listed = entriesOf(text(now));
            back = Math.min(back, firstListed(listed, now, listedAt, 41));
          }
        }
        // The slate gives way no sooner than the stream's video is about as much as time passed.
        expect(back, where).toBeGreaterThanOrEqual(done - 2 / (rate - 1) - 1);
        expect(back, where).toBeLessThanOrEqual(done + 4);
        // After the slate the stream is in one piece, and every file listed is there for twelve
        // seconds at least: VLC asks for the second segment behind a discontinuity some ten seconds
        // after the first.
        expect(at(110).split(" | ").at(-1), where).toMatch(/^g1:\d+( g1:\d+)*$/);
        for (const [uri, listed] of listedAt) {
          const index = Number(/seg_(\d+)/.exec(uri)?.[1] ?? NaN);
          const gone = writes[index + 10] ?? Infinity;
          expect(gone - listed, `${where}: ${uri}`).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  it("counts on for a stream that came back late until it left out as much as the slate stood in for", () => {
    // Three seconds late, the count left out as much as the slate stood in for, give or take two
    // seconds, and ended: all of it is listed.
    expect(backlog(3)).toBe("g1:55 g1:56 g1:57 g1:58 g1:59 g1:60");
    // Five seconds late, it would put the playlist four seconds ahead of the time that passed: the
    // count goes on, and leaves out what doesn't fit.
    expect(backlog(5)).toBe("g1:52 g1:53 g1:54 g1:55 g1:56 | g1:59");
    // So it does where the stream pauses again meanwhile, and makes up for that pause at once:
    // the count after that pause owes what the stream is still behind, and leaves those seconds out.
    expect(backlog(9, true)).toBe("g1:49 g1:50 g1:51 g1:52 g1:53 g1:54");
  });

  it("counts until the stream made up for its pause, however slowly it does", () => {
    for (const rate of [1.08, 1.1, 1.15, 1.2]) {
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        const where = `${String(rate)}x, looks at ${String(phase)}`;
        const { writes, done } = catchingUp(rate, 200);
        const { most, listedAt, at, segment } = playedSlowly(writes, phase, [9], 400);
        // It makes up for twenty seconds within two minutes or four: the playlist never lists more
        // than the time that passed and the four seconds the count may be off by.
        expect(done, where).toBeLessThan(350);
        expect(most[0], where).toBeLessThanOrEqual(4);
        // At that pace every file listed is there long enough.
        expect(shortestLife(writes, listedAt), where).toBeGreaterThanOrEqual(12);
        // Once it made up for its pause, the count ends: all it delivers is listed again.
        for (const index of [200, 201, 202]) {
          segment(401, 1, index);
        }
        expect(at(401), where).toMatch(/g1:199 g1:200 g1:201 g1:202$/);
      }
    }
  });

  it("counts on through another pause while the stream still makes up slowly for the first", () => {
    for (const rate of [1.05, 1.1, 1.15]) {
      for (const phase of [0, 0.5]) {
        const where = `${String(rate)}x, looks at ${String(phase)}`;
        // It pauses again for six seconds at 70, and then makes up for both pauses.
        const { writes, done } = catchingUp(rate, 320, { at: 70, lasting: 6 });
        const second = writes.findLastIndex((one) => one < 70);
        const { most, listedAt } = playedSlowly(writes, phase, [9, second], 640);
        expect(done, where).toBeLessThan(620);
        // Since the stream's last segment before either pause, the playlist never lists more than
        // the time that passed and four seconds.
        expect(Math.max(...most), where).toBeLessThanOrEqual(4);
        expect(shortestLife(writes, listedAt), where).toBeGreaterThanOrEqual(12);
        // Once it made up for both, nothing it delivers in its own time is left out.
        const uris = listedAt.keys().toArray();
        const missing = writes
          .map((one, index) =>
            one === 2 * (index + 1) && one > done ? `g1/full/seg_${String(index).padStart(6, "0")}.ts` : "",
          )
          .filter((name) => name !== "" && uris.every((uri) => !uri.endsWith(name)));
        expect(missing, where).toEqual([]);
      }
    }
  });

  it("starts the next count owing nothing, not less, where the stream is ahead when the slate takes over again", () => {
    for (const rate of [1.05, 1.08, 1.1]) {
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        const where = `${String(rate)}x, looks at ${String(phase)}`;
        // The stream stops at 20, and comes back at 30 as another ffmpeg run whose first three
        // segments come at once. The count takes that run's first segment as on time, so with the
        // next two its video is four seconds ahead of the time that passed. It stops again at 40,
        // while the count still runs, and from 48 makes up for that slowly.
        const writes: number[] = [];
        const runs: number[] = [];
        for (let index = 0; index < 10; index += 1) {
          writes.push(2 * (index + 1));
          runs.push(1);
        }
        for (let index = 0; index < 120; index += 1) {
          const end = 40 + 2 * (index - 7);
          writes.push(index < 3 ? 30 : index < 8 ? 30 + 2 * (index - 2) : Math.max(48 + (end - 40) / rate, end));
          runs.push(2);
        }
        const { most } = playedSlowly(writes, phase, [9, 17], 260, runs);
        // Since the stream's last segment before the second pause, the playlist never lists more
        // than the time that passed and four seconds: what the stream was ahead doesn't end the
        // count before it made up for the pause.
        expect(most[1], where).toBeLessThanOrEqual(4);
      }
    }
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
    // seconds, eight more would be twelve in the eight and a half that passed since its last
    // segment: every player would be that much further behind from here on. The newest fits, with
    // the two seconds to spare that are asked of video that comes late.
    for (const index of [3, 4, 5, 6]) {
      segment(12.5, 1, index);
    }
    expect(at(12.5)).toBe("g1:0 g1:1 g1:2 | s0 s1 | g1:6");
    // What comes in its own time after that is listed.
    segment(14.5, 1, 7);
    segment(16.5, 1, 8);
    expect(at(16.5)).toBe("g1:2 | s0 s1 | g1:6 g1:7 g1:8");
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
    // The data of the pause is lost, and the first segment after it has a jump in its timestamps: it
    // says it lasts the pause as well. With the slate's seconds that is more than the time that
    // passed. The slate goes on.
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
    // The stream is back with what it missed, and the newest of it is listed.
    for (const index of [2, 3, 4]) {
      segment(8.5, 1, index);
    }
    expect(at(8.5)).toBe("g1:0 g1:1 | s0 | g1:4");
    // Then it delivers more than that, three segments at once. Eight seconds and a fifth passed
    // since its last segment before the slate, and four are listed: the newest fits, with two to
    // spare.
    for (const index of [5, 6, 7]) {
      segment(10.2, 1, index);
    }
    expect(at(10.2)).toBe("g1:0 g1:1 | s0 | g1:4 | g1:7");
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

  it("comes back from the slate in one piece when ffmpeg wrote more segments between two looks than it lists", () => {
    const { at, segment } = make();
    for (let index = 22; index <= 27; index += 1) {
      segment(38.2 - 2 * (27 - index), 1, index);
    }
    // After a pause of almost half a minute, the stream sends what it missed at once, and ffmpeg
    // writes it unevenly: of the segments it wrote between two looks, the pipeline sees only the
    // six its playlist lists, so it never sees 31. Then the stream goes on in its own time.
    const looks: [number, number[]][] = [
      [66.9, [28, 29, 30]],
      [67.9, [32, 33, 34, 35, 36, 37]],
      [68.3, [38]],
      [68.9, [39]],
      [69.4, [40, 41, 42]],
    ];
    for (let index = 43; index <= 60; index += 1) {
      looks.push([69.4 + 2 * (index - 42), [index]]);
    }
    const played: string[] = [];
    for (let now = 39; now <= 106; now = Math.round((now + 0.5) * 10) / 10) {
      for (const [seconds, indexes] of looks) {
        if (seconds > now - 0.5 && seconds <= now) {
          for (const index of indexes) {
            segment(seconds, 1, index);
          }
          played.push(at(seconds));
        }
      }
      played.push(at(now));
    }
    // The video that went unseen came all the same: the slate gives way once the stream made up
    // for its pause, and the stream goes on from there without a jump.
    expect(
      played.some((listed) => / \| g1:\d+$/.test(listed) && /s\d+ \| g1/.test(listed)),
      "back",
    ).toBe(true);
    expect(
      played.filter((listed) => /g1:\d+ \| g1:/.test(listed.slice(listed.indexOf("s")))),
      "jumps",
    ).toEqual([]);
    expect(at(106)).toBe("g1:55 g1:56 g1:57 g1:58 g1:59 g1:60");
  });

  it("goes to the slate at once when ffmpeg deleted the files of all it lists", () => {
    const { at, text, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(8)).toBe("g1:0 g1:1 | s0");
    for (const index of [2, 3, 4, 5, 6]) {
      segment(9, 1, index);
    }
    expect(at(9)).toBe("g1:0 g1:1 | s0 | g1:6");
    // Right after that, the stream delivers more, all at once. None of it fits, and ffmpeg deleted
    // the files of all that is listed: a playlist without segments would end a player.
    for (let index = 7; index <= 18; index += 1) {
      segment(9.5, 1, index);
    }
    expect(at(9.5)).toBe("| s0 s1 s2");
    expect(sequences(text(9.5))).toEqual([4, 2]);
    segment(11.5, 1, 19);
    expect(at(11.5)).toBe("| s0 s1 s2 | g1:19");
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
    // Back with four segments at once. Nine seconds passed and four are listed, so the newest fits,
    // with two seconds to spare.
    for (const index of [3, 4, 5, 6]) {
      segment(13, 1, index);
    }
    expect(at(13)).toBe("g1:0 g1:1 g1:2 | s0 s1 | g1:6");
    // The stream goes on in its own time. Its next segment is noticed a second after it was
    // written and the one after that at once: a millisecond less than a second apart.
    segment(15, 1, 7);
    segment(15.999, 1, 8);
    expect(at(16)).toBe("g1:2 | s0 s1 | g1:6 g1:7 g1:8");
  });

  it("asks two seconds to spare of segments that make up for a pause, and nothing of one that fits alone", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    segment(4, 1, 2);
    expect(at(9)).toBe("g1:0 g1:1 g1:2 | s0");
    expect(at(11)).toBe("g1:0 g1:1 g1:2 | s0 s1");
    for (const index of [3, 4, 5, 6]) {
      segment(13.6, 1, index);
    }
    expect(at(13.6)).toBe("g1:0 g1:1 g1:2 | s0 s1 | g1:6");
    // The stream goes on in its own time, two seconds after those.
    segment(15.6, 1, 7);
    // Half a second behind that one, a segment makes up for a pause. Twelve seconds and a tenth
    // passed, and eight are listed: it fits.
    segment(16.1, 1, 8);
    expect(at(16.1)).toBe("g1:2 | s0 s1 | g1:6 g1:7 g1:8");
    // Two at once, 0.8 seconds after that: 12.9 passed and ten are listed. One would fit, but not
    // with two seconds to spare, so both are left out.
    segment(16.9, 1, 9);
    segment(16.9, 1, 10);
    expect(at(16.9)).toBe("g1:2 | s0 s1 | g1:6 g1:7 g1:8");
    // The next one in its own time fits, behind a discontinuity.
    segment(18.1, 1, 11);
    expect(at(18.1)).toBe("g1:2 | s0 s1 | g1:6 g1:7 g1:8 | g1:11");
  });

  it("lists all the stream delivers again once its segments came for half a minute", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    expect(at(5)).toBe("g1:0 | s0");
    // Back after six seconds with what it missed, and one segment every two seconds for half a
    // minute after that.
    segment(6, 1, 1);
    segment(6, 1, 2);
    expect(at(6)).toBe("g1:0 | s0 | g1:2");
    for (let index = 3; index <= 17; index += 1) {
      segment(2 * index + 2, 1, index);
    }
    expect(at(36)).toBe("g1:12 g1:13 g1:14 g1:15 g1:16 g1:17");
    // Three at once after that are all listed, as in the page's playlist.
    for (const index of [18, 19, 20]) {
      segment(38, 1, index);
    }
    expect(at(38)).toBe("g1:15 g1:16 g1:17 g1:18 g1:19 g1:20");
    // Sooner after the slate, only one of three fits: 22 seconds passed since the stream's last
    // segment before the slate, and 18 are listed. The first ones listed left with their files.
    const soon = make();
    soon.segment(0, 1, 0);
    expect(soon.at(5)).toBe("g1:0 | s0");
    soon.segment(6, 1, 1);
    soon.segment(6, 1, 2);
    for (let index = 3; index <= 9; index += 1) {
      soon.segment(2 * index + 2, 1, index);
    }
    for (const index of [10, 11, 12]) {
      soon.segment(22, 1, index);
    }
    expect(soon.at(22)).toBe("g1:3 g1:4 g1:5 g1:6 g1:7 g1:8 g1:9 | g1:12");
  });

  it("lists all the stream delivers after a pause too short for the slate, once it is back from one", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(11)).toBe("g1:0 g1:1 | s0 s1 s2");
    for (const index of [2, 3, 4, 5, 6]) {
      segment(12, 1, index);
    }
    expect(at(12)).toBe("g1:0 g1:1 | s0 s1 s2 | g1:6");
    segment(14, 1, 7);
    segment(16, 1, 8);
    // The stream pauses again, for less than the slate waits, and then delivers the time it
    // missed at once: no slate stood in for it, so all of it is listed.
    segment(20.4, 1, 9);
    segment(20.4, 1, 10);
    expect(at(20.4)).toBe("g1:1 | s0 s1 s2 | g1:6 g1:7 g1:8 g1:9 g1:10");
    segment(22.4, 1, 11);
    expect(at(22.4)).toBe("s0 s1 s2 | g1:6 g1:7 g1:8 g1:9 g1:10 g1:11");
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
    // With these three, eight seconds passed and four are listed: the newest fits, with two to spare.
    for (const index of [1, 2, 3]) {
      segment(8, 1, index);
    }
    expect(at(8)).toBe("g1:0 | s0 s1 | g1:3");
    // The same again, from when the last of them came.
    expect(at(13)).toBe("g1:0 | s0 s1 | g1:3 | s0");
    expect(at(15)).toBe("g1:0 | s0 s1 | g1:3 | s0 s1");
    for (const index of [4, 5, 6]) {
      segment(16, 1, index);
    }
    expect(at(16)).toBe("g1:0 | s0 s1 | g1:3 | s0 s1 | g1:6");
  });

  it("keeps counting through a slate that shows for longer than half a minute", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    for (let seconds = 2; seconds <= 40; seconds += 2) {
      at(seconds);
    }
    expect(at(40)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2");
    // The stream is back with what it missed. ffmpeg wrote more than its playlist lists meanwhile:
    // the six it lists come, and the newest fits.
    for (let index = 15; index <= 20; index += 1) {
      segment(40.5, 1, index);
    }
    expect(at(40.5)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2 | g1:20");
    // A moment later it delivers more than the time that passed: the slate showed less than half a
    // minute ago, so it counts on.
    for (const index of [21, 22, 23]) {
      segment(42.5, 1, index);
    }
    expect(at(42.5)).toBe("s2 | s0 s1 s2 | s0 s1 s2 | s0 s1 s2 | g1:20 | g1:23");
  });

  it("keeps counting for half a minute after the last segment it left out", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(10)).toBe("g1:0 g1:1 | s0 s1");
    for (const index of [2, 3, 4, 5]) {
      segment(10.5, 1, index);
    }
    expect(at(10.5)).toBe("g1:0 g1:1 | s0 s1 | g1:5");
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
    // The run that follows starts with three segments at once. Eight and a half seconds passed, and
    // four are listed: the newest fits, with two to spare.
    for (const index of [0, 1, 2]) {
      segment(10.5, 2, index);
    }
    expect(at(10.5)).toBe("g1:0 g1:1 | s0 s1 | g2:2");
  });

  it("lists no more than three of the segments that waited, the newest", () => {
    const { at, segment } = make();
    // Segments of ten seconds: the slate waits thirteen.
    segment(0, 1, 0, 10);
    segment(10, 1, 1, 10);
    expect(at(23)).toBe("g1:0 g1:1 | s0");
    // The stream is back with what it missed, as a run of segments of two seconds: five would fit
    // in the time that passed. The oldest of them would be gone before VLC asks for the second
    // segment behind the slate. (ffmpeg deleted the files of the two before the slate.)
    for (let index = 2; index <= 11; index += 1) {
      segment(24, 1, index, 2);
    }
    expect(at(24)).toBe("s0 | g1:9 g1:10 g1:11");
  });

  it("lets a segment that comes alone miss the time that passed by up to two seconds, once a count", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(9)).toBe("g1:0 g1:1 | s0 s1");
    for (const index of [2, 3, 4, 5]) {
      segment(10, 1, index);
    }
    expect(at(10)).toBe("g1:0 g1:1 | s0 s1 | g1:5");
    // Then the stream delivers faster than in real time, one segment every half a second. The
    // first one fits, the second misses by half a second: it may be the stream in its own time,
    // noticed early, so it is listed, and the count goes on from it with two seconds to spare.
    segment(11, 1, 6);
    segment(11.5, 1, 7);
    segment(12, 1, 8);
    expect(at(12)).toBe("g1:1 | s0 s1 | g1:5 g1:6 g1:7 g1:8");
    // The next one misses by a second and a half, and is left out.
    segment(12.5, 1, 9);
    segment(14.5, 1, 10);
    expect(at(14.5)).toBe("g1:1 | s0 s1 | g1:5 g1:6 g1:7 g1:8 | g1:10");
  });

  it("leaves out a segment that waited while the slate showed and doesn't fit, though it comes alone", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    segment(2, 1, 1);
    expect(at(7)).toBe("g1:0 g1:1 | s0");
    // A segment of six seconds, 6.9 seconds after the one before: it made up for the pause, and
    // misses the time that passed by 1.1 seconds. The slate goes on.
    segment(8.9, 1, 2, 6);
    expect(at(8.9)).toBe("g1:0 g1:1 | s0");
    expect(at(9)).toBe("g1:0 g1:1 | s0 s1");
  });

  it("keeps time by a clock that never goes back", () => {
    const before = steadyNow();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
    try {
      expect(steadyNow()).toBeGreaterThanOrEqual(before);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it(
    "never lists more than the time that passed since the stream's last segment before the slate",
    () => {
      for (let seed = 1; seed <= 150; seed += 1) {
        const random = seeded(seed);
        const { text, segment } = make();
        const written = pausingStream(random, RANDOM_STREAM_SECONDS);
        const watch = new Watch(`seed ${String(seed)}`, written);
        const phase = random();
        let next = 0;
        let asked = 0;
        for (let now = 2; now < RANDOM_STREAM_SECONDS; now += 0.5 + random() * 1.5) {
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
    },
    LONG_TEST_MS,
  );

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
