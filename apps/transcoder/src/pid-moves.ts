import {
  audioSettings,
  packetParts,
  pesStart,
  shiftPcr,
  shiftPes,
  streamKind,
  tsAdd,
  tsDiff,
  videoStart,
  type PacketParts,
  type PesStart,
  type StreamKind,
} from "./es-headers.ts";
import { PACKET_BYTES } from "./ts-packets.ts";
import { formatOf, streamPids, type Layout, type Program, type StreamEntry } from "./ts-tables.ts";

/**
 * How much of an access unit's start is read for its decoder settings and the kind of its picture:
 * the settings are a few hundred bytes at most, and so is what encoders put between them and the picture.
 */
const HEAD_BYTES = 4096;
/**
 * How long, and how much of the stream, a move may take to show a picture a decoder can go on
 * from. Streams made for live viewing have one every second or two; past this, starting ffmpeg
 * over (which waits for one as well) is no slower.
 */
const PATIENCE_MS = 2500;
const HOLD_BYTES = 4 * 1024 * 1024;
/** The time between two access units, until a stream has shown its own: 25 pictures a second, AAC at 48 kHz. */
const VIDEO_UNIT_TICKS = 3600;
const AUDIO_UNIT_TICKS = 1920;
const NO_PID = 0x1f_ff;
/** A step back in a stream's timestamps larger than this (10 s) is the stream starting over, not frames out of order. */
const RESTART_TICKS = 900_000;

/** Reads the decoder settings a stream sends, one access unit after the other. */
class SettingsReader {
  /** Whether the unit whose settings were returned last is one a decoder can start at (see `VideoStart.key`). */
  key = false;
  private readonly kind: StreamKind;
  private readonly head = new Uint8Array(HEAD_BYTES);
  /** How much of the current access unit's start is in `head`; -1 while none is being read. */
  private length = -1;

  constructor(kind: StreamKind) {
    this.kind = kind;
  }

  /** The access unit being read ends here: its settings ("" for none), or undefined if none was being read. */
  end(): string | undefined {
    return this.kind.kind === "video" && this.length >= 0 ? this.read(this.kind.codec, true) : undefined;
  }

  /**
   * The stream's next packet, with `pes` when an access unit starts in it. Returns that unit's
   * settings once they can be told ("" when it has none), undefined until then.
   */
  packet(data: Uint8Array, at: number, parts: PacketParts, pes: PesStart | undefined): string | undefined {
    const { kind } = this;
    const end = at + PACKET_BYTES;
    if (kind.kind === "audio") {
      return pes === undefined ? undefined : (audioSettings(kind.format, data, pes.dataAt, end) ?? "");
    }
    if (kind.kind !== "video") {
      return undefined;
    }
    if (parts.unitStart) {
      // One whose header can't be read has no start to read from.
      this.length = pes === undefined ? -1 : 0;
    }
    const from = pes?.dataAt ?? parts.payloadAt;
    if (this.length < 0 || from < 0) {
      return undefined;
    }
    const take = Math.min(end - from, HEAD_BYTES - this.length);
    this.head.set(data.subarray(from, from + take), this.length);
    this.length += take;
    return this.read(kind.codec, this.length === HEAD_BYTES);
  }

  /** What the unit's start tells so far, if that is all it takes: the unit is done with then. */
  private read(codec: "h264" | "hevc", whole: boolean): string | undefined {
    const start = videoStart(codec, this.head.subarray(0, this.length), whole);
    if (start === undefined) {
      return undefined;
    }
    this.length = -1;
    this.key = start.key;
    return start.settings;
  }
}

/** A stream of video or audio the run's ffmpeg reads: what it was last given. */
interface Watched {
  kind: StreamKind;
  reader: SettingsReader;
  /** The decoder settings the stream last sent. */
  settings: string | undefined;
  /** The decode time of the newest access unit, and the latest time any is shown. */
  lastDts: number | undefined;
  lastPts: number | undefined;
  /** The time from one access unit to the next. */
  unit: number;
}

/** A PID the run's ffmpeg knows. */
interface Known {
  /** The continuity counter of the last packet it got on it; -1 before the first. */
  counter: number;
  watched: Watched | undefined;
}

/** Where the packets of one of the stream's PIDs go, once the stream moved. */
interface Gate {
  to: number;
  known: Known;
  /** Whether the stream's packets are passed on yet: from a point the decoder can go on from. */
  open: boolean;
  lead: boolean;
  /**
   * What is added to the stream's own continuity counters, so that they go on from the last one
   * ffmpeg got on the PID; undefined until the first packet is passed on.
   */
  shift: number | undefined;
  /** Nothing about the PID changed: its packets go on untouched. */
  same: boolean;
}

/**
 * What ffmpeg gets once the stream's layout changed: the packets on the PIDs that have a gate,
 * and nothing else. Not the tables (it keeps the ones it has), not what still comes on PIDs its
 * streams left, and no stream it doesn't know: for one of those it would hold everything back
 * until it has studied it (up to `-probesize` of input), with no frame for players meanwhile.
 */
interface Moved {
  gates: Map<number, Gate>;
  /** What is added to the stream's timestamps, so that they go on where the old ones ended. */
  offset: number;
  /** When the first picture passed on is shown, on the stream's own clock. */
  startPts: number;
  leadOpen: boolean;
}

interface Candidate {
  /** Where in `held` the access unit starts. */
  index: number;
  pts: number;
  dts: number;
}

interface Search {
  layout: Layout;
  places: Map<number, number>;
  /** PIDs the new layout has for streams that are none of the run's: left out, whatever was on them before. */
  others: Set<number>;
  /** What ffmpeg got before the move came up, and gets again if it is given up. */
  before: Moved | undefined;
  leadPid: number;
  held: { pid: number; bytes: Uint8Array }[];
  bytes: number;
  since: number;
  reader: SettingsReader;
  candidate: Candidate | undefined;
  /** The access unit to go on from: the first with the settings the decoder has. */
  start: Candidate | undefined;
  /** The audio streams, by their new PID, and whether each has shown the settings its decoder has. */
  audio: Map<number, boolean>;
}

/** A move the run can't read on over: the packets held for it, as they came, and why not. */
export interface MoveFailure {
  failed: Uint8Array[];
  why: string;
}

/** What to do with a packet: pass it on (as it is now), leave it out, or nothing yet (it is held). */
export type PacketVerdict = "pass" | "drop" | "hold" | MoveFailure | { carried: Uint8Array };

/** The streams of a program that are, or may be, video or audio: the ones a layout is about (see `formatOf`). */
const followed = (program: Program): StreamEntry[] => program.streams.filter((entry) => formatOf(entry) !== undefined);

/**
 * Which PID of `base` each PID of `next` takes the place of, if `next` is `base` on other PIDs:
 * the same programs, each with the same streams of video and audio in the same order and of the
 * same formats, and the clock reference on the same one of them. Undefined if anything else
 * differs. Streams of other data are no part of it: ffmpeg reads none of them.
 */
export function placesOf(base: Layout, next: Layout): Map<number, number> | undefined {
  if (base.programs.length !== next.programs.length) {
    return undefined;
  }
  const places = new Map<number, number>();
  const taken = new Map<number, number>();
  const put = (from: number, to: number): boolean => {
    if ((places.get(from) ?? to) !== to || (taken.get(to) ?? from) !== from) {
      return false;
    }
    places.set(from, to);
    taken.set(to, from);
    return true;
  };
  for (const [index, was] of base.programs.entries()) {
    const now = next.programs[index];
    const before = followed(was);
    const after = now === undefined ? [] : followed(now);
    if (now === undefined || after.length !== before.length || (now.pcrPid === NO_PID) !== (was.pcrPid === NO_PID)) {
      return undefined;
    }
    for (const [position, entry] of before.entries()) {
      const other = after[position];
      if (other === undefined || formatOf(other) !== formatOf(entry) || !put(other.pid, entry.pid)) {
        return undefined;
      }
    }
    // The clock reference rides on one of the streams, or on a PID of its own.
    if (was.pcrPid !== NO_PID && !put(now.pcrPid, was.pcrPid)) {
      return undefined;
    }
  }
  return places;
}

const entriesOf = (layout: Layout): StreamEntry[] => layout.programs.flatMap((program) => followed(program));
const kindsOf = (layout: Layout): (string | undefined)[] => entriesOf(layout).map((entry) => streamKind(entry)?.kind);

/**
 * Whether every stream an ffmpeg run on `real` reads is where it was in `next`, with the format it
 * had, whatever else the tables say now. ffmpeg takes the first video and the first audio stream
 * (see `buildFfmpegArgs`), so in a program whose streams are all known to be one or the other,
 * those two count, and the others may come and go. A kind the run has none of is another matter:
 * when sound begins on a stream that had none, only a new run takes it. Where the tables don't
 * tell which streams ffmpeg reads (several programs, or a stream of a kind not known here), they
 * all have to be where they were, and nothing may be new.
 */
export function staysPut(real: Layout, next: Layout): boolean {
  const kinds = kindsOf(real);
  if (real.programs.length !== 1 || kinds.includes(undefined)) {
    const places = placesOf(real, next);
    return places !== undefined && [...places].every(([from, to]) => from === to);
  }
  const read = entriesOf(real).filter((_entry, index) => kinds.indexOf(kinds[index]) === index);
  const there = new Map(entriesOf(next).map((entry) => [entry.pid, formatOf(entry)]));
  const now = kindsOf(next);
  const gains = ["video", "audio"].some(
    (kind) => !kinds.includes(kind) && now.some((other) => (other ?? kind) === kind),
  );
  return !gains && read.every((entry) => there.get(entry.pid) === formatOf(entry));
}

/**
 * Carries an ffmpeg run over a move of the broadcast's streams to other PIDs.
 *
 * ffmpeg reads the PIDs it found at its start. When the broadcast moves the same streams to other
 * PIDs (see `placesOf`), their packets can be given to ffmpeg under the PIDs it knows, and it
 * reads on as if nothing happened: no new run, and no break in what players get. That only works
 * if the decoders can go on with what follows, so nothing is passed on until the stream has shown
 * that:
 *
 * - The video (H.264 or HEVC) goes on from the first picture a decoder can start at (see
 *   `VideoStart.key`) that carries its decoder settings (the parameter sets, which encoders send
 *   with such pictures), and only if they are byte for byte the ones the decoder has. Until then
 *   the new PIDs' packets are held back, for at most `PATIENCE_MS`.
 * - Every audio stream's frame header (AAC, MPEG audio, AC-3) says what the old one said.
 * - Anything that can't be checked this way means no: another video codec, an unknown stream
 *   type, a second video stream. The caller then starts ffmpeg over, as for a change of codec.
 *
 * What is passed on continues the old stream without a break: timestamps go on from the last
 * ones ffmpeg got (the new encoder's own clock may be anywhere), and so does each PID's
 * continuity counter. So ffmpeg drops nothing at the move: if the old stream was cut in the
 * middle of a picture, that one picture reaches the decoders damaged, and the next one is a
 * picture they can start at. A gap would be worse than that: ffmpeg 9 can stop for good when a
 * video frame is missing at the wrong moment (the preview's `fps` filter then repeats a frame,
 * and its threads end up waiting for each other). After its first packet a PID's counters step
 * as the stream's own do, so what the stream loses on its way shows to ffmpeg as it does on a
 * stream that never moved. The stream's new tables are left out (ffmpeg keeps the ones it has),
 * and so is everything on PIDs that are not the run's (see `Moved`).
 */
export class PidMoves {
  private readonly now: () => number;
  /** What the run's ffmpeg was told the stream carries, and the layout whose PIDs its streams are on now. */
  private base: Layout | undefined;
  private real: Layout | undefined;
  private known = new Map<number, Known>();
  private lead: { pid: number; watched: Watched } | undefined;
  private moved: Moved | undefined;
  private search: Search | undefined;

  constructor(now: () => number) {
    this.now = now;
  }

  /**
   * A run begins that reads `layout`. `given` is what of the stream it gets before anything else
   * (whole packets): its streams' decoder settings and times may be in there.
   */
  begin(layout: Layout, given: readonly Uint8Array[] = []): void {
    this.base = layout;
    this.real = layout;
    this.known = new Map();
    this.lead = undefined;
    this.moved = undefined;
    this.search = undefined;
    let checkable = true;
    for (const program of layout.programs) {
      for (const entry of program.streams) {
        const kind = streamKind(entry);
        const watched = kind === undefined || kind.kind === "other" ? undefined : newWatched(kind);
        this.known.set(entry.pid, { counter: -1, watched });
        // One video stream, and nothing whose decoder settings can't be read.
        checkable &&= kind !== undefined && (kind.kind !== "video" || this.lead === undefined);
        if (kind?.kind === "video" && watched !== undefined) {
          this.lead ??= { pid: entry.pid, watched };
        }
      }
      if (!this.known.has(program.pcrPid)) {
        this.known.set(program.pcrPid, { counter: -1, watched: undefined });
      }
    }
    if (!checkable) {
      this.lead = undefined;
    }
    for (const bytes of given) {
      for (let at = 0; at + PACKET_BYTES <= bytes.length; at += PACKET_BYTES) {
        this.packet(bytes, at, (((bytes[at + 1] ?? 0) & 0x1f) << 8) | (bytes[at + 2] ?? 0), false);
      }
    }
  }

  /**
   * The stream's layout is `next` from here on. Tells whether the run can go on:
   * - "carried": every stream it reads is where it was (see `staysPut`): the tables alone changed,
   *   or streams it doesn't read came or went. Those are left out from here on, like the new tables.
   * - "looking": its streams moved to other PIDs. Their packets are held until the stream shows
   *   whether the decoders can go on (see `packet`).
   * - `no`: it is another stream now, or one that can't be checked; with the reason. So is a move
   *   that `waited` for its turn (see `FollowBrake`): the run was given the stream as it came
   *   meanwhile, new tables and all, so it is not where a move could take it on from.
   */
  consider(next: Layout, waited = false): "carried" | "looking" | { no: string } {
    const { base, real, lead } = this;
    if (base === undefined || real === undefined) {
      return { no: "no run reads the stream yet" };
    }
    if (staysPut(real, next)) {
      this.moved ??= this.inPlace();
      return "carried";
    }
    if (waited) {
      return { no: "the change had to wait its turn, and the run got the stream as it came meanwhile" };
    }
    const places = placesOf(base, next);
    const stays = placesOf(real, next);
    if (places === undefined || stays === undefined) {
      return { no: "the streams are not the same ones on other PIDs" };
    }
    if (lead === undefined) {
      return { no: "the run reads streams whose decoder settings can't be compared" };
    }
    const leadPid = [...places].find(([, to]) => to === lead.pid)?.[0];
    const audio = [...places].filter(([, to]) => this.known.get(to)?.watched?.kind.kind === "audio");
    const ready =
      lead.watched.settings !== undefined &&
      lead.watched.lastDts !== undefined &&
      audio.every(([, to]) => this.known.get(to)?.watched?.settings !== undefined);
    // The video stays where it is and something else moved: holding the video back for that would cost more than it saves.
    if (leadPid === undefined || stays.get(leadPid) === leadPid) {
      return { no: "the video stayed on its PID" };
    }
    if (!ready) {
      return { no: "the run has not read its streams' decoder settings yet" };
    }
    this.search = {
      layout: next,
      places,
      others: streamPids(next).difference(places),
      before: this.moved,
      leadPid,
      held: [],
      bytes: 0,
      since: this.now(),
      reader: new SettingsReader(lead.watched.kind),
      candidate: undefined,
      start: undefined,
      audio: new Map(audio.map(([from]) => [from, false])),
    };
    // While it is looked at, the run's PIDs go on as they do, and nothing else is let in.
    this.moved ??= this.inPlace();
    return "looking";
  }

  /** Gives up on a move that took too long to show a picture to go on from. */
  expire(): MoveFailure | undefined {
    const { search } = this;
    const late = search !== undefined && this.now() - search.since >= PATIENCE_MS;
    return late
      ? { failed: this.giveUp(), why: `no picture to go on from in ${String(PATIENCE_MS / 1000)}s` }
      : undefined;
  }

  /** Gives up on the move being looked at, if any (the stream changed again): what was held, as it came. */
  giveUp(): Uint8Array[] {
    const { search } = this;
    this.search = undefined;
    this.moved = search === undefined ? this.moved : search.before;
    return search?.held.map((packet) => packet.bytes) ?? [];
  }

  /**
   * The stream's next packet (the 188 bytes at `at`), on `pid`; `table` when the PID carries
   * program tables. Tells what becomes of it:
   * - "pass": ffmpeg gets it, as it is now (a moved stream's packet was rewritten in place).
   * - "drop": it is left out.
   * - "hold": it is kept until the move it belongs to is decided.
   * - `carried`: the move is on. These are the packets held so far that ffmpeg gets, rewritten.
   * - `failed`: the decoders can't go on (see `MoveFailure`).
   */
  packet(data: Uint8Array, at: number, pid: number, table: boolean): PacketVerdict {
    const { search, moved } = this;
    if (search?.places.has(pid) === true) {
      return this.hold(search, data, at, pid);
    }
    if (moved === undefined) {
      // The stream is as the run found it: all of it is ffmpeg's.
      const known = this.known.get(pid);
      if (known !== undefined) {
        this.note(known, data, at, packetParts(data, at));
      }
      return "pass";
    }
    const gate = table || search?.others.has(pid) === true ? undefined : moved.gates.get(pid);
    return gate !== undefined && this.through(moved, gate, data, at) ? "pass" : "drop";
  }

  /** The gates of a run whose streams are where it found them: each of its PIDs goes on as it comes (see `Moved`). */
  private inPlace(): Moved {
    const gates = this.known.keys().map((pid): [number, Gate] => [pid, this.gate(pid, true)]);
    return { gates: new Map(gates), offset: 0, startPts: 0, leadOpen: true };
  }

  private gate(to: number, same: boolean): Gate {
    // Every PID a gate leads to is one of the run's.
    const known = this.known.get(to) ?? { counter: -1, watched: undefined };
    return { to, known, open: same, lead: to === this.lead?.pid, shift: undefined, same };
  }

  /** Keeps a packet of a stream that moved, and looks at what it tells about going on. */
  private hold(search: Search, data: Uint8Array, at: number, pid: number): PacketVerdict {
    const bytes = data.slice(at, at + PACKET_BYTES);
    search.held.push({ pid, bytes });
    search.bytes += PACKET_BYTES;
    const parts = packetParts(bytes, 0);
    const pes = pesStart(bytes, 0, parts);
    let why: string | undefined;
    if (pid === search.leadPid) {
      // Also once a picture to go on from is found: until the move is on, the video must not show other settings.
      why = this.lookForStart(search, bytes, parts, pes) ? undefined : "the video's decoder settings differ";
    } else if (pes !== undefined && !this.audioFits(search, pid, bytes, parts, pes)) {
      why = "an audio stream's settings differ";
    }
    if (why === undefined && search.bytes >= HOLD_BYTES) {
      why = `no picture to go on from in ${String(HOLD_BYTES / 1024 / 1024)} MB`;
    }
    if (why !== undefined) {
      return { failed: this.giveUp(), why };
    }
    const found = search.start !== undefined && search.audio.values().every(Boolean);
    return found ? { carried: this.carry(search) } : "hold";
  }

  /** Whether an audio stream's decoder can go on with the frames that start in this packet (true for other streams). */
  private audioFits(search: Search, pid: number, bytes: Uint8Array, parts: PacketParts, pes: PesStart): boolean {
    const watched = search.audio.has(pid) ? this.known.get(search.places.get(pid) ?? NO_PID)?.watched : undefined;
    const settings = watched?.reader.packet(bytes, 0, parts, pes);
    if (settings === undefined || settings === "") {
      return true;
    }
    if (settings === watched?.settings) {
      search.audio.set(pid, true);
    }
    return settings === watched?.settings;
  }

  /** Whether the video can still go on, after this packet of it: false once it showed other settings. */
  private lookForStart(search: Search, bytes: Uint8Array, parts: PacketParts, pes: PesStart | undefined): boolean {
    const mine = this.lead?.watched.settings;
    const judge = (settings: string | undefined): boolean => {
      if (settings === undefined || settings === "") {
        return true;
      }
      // The same settings in front of a picture that needs earlier ones are no place to start: the search goes on.
      if (settings === mine && search.reader.key) {
        search.start ??= search.candidate;
      }
      return settings === mine;
    };
    if (parts.unitStart) {
      // The access unit before this one ends here: what it had of settings is all of them.
      if (!judge(search.reader.end())) {
        return false;
      }
      const index = search.held.length - 1;
      search.candidate = pes?.pts === undefined ? undefined : { index, pts: pes.pts, dts: pes.dts ?? pes.pts };
    }
    return judge(search.reader.packet(bytes, 0, parts, pes));
  }

  /** The move is on: sets the gates up, and returns what of the held packets ffmpeg gets. */
  private carry(search: Search): Uint8Array {
    const start = search.start;
    const lead = this.lead?.watched;
    if (start === undefined || lead?.lastDts === undefined) {
      throw new Error("a move without a picture to go on from");
    }
    // The first picture comes one unit after the last one ffmpeg got, by decode time and by show time.
    const byDts = tsAdd(tsAdd(lead.lastDts, lead.unit), -start.dts);
    const byPts = lead.lastPts === undefined ? byDts : tsAdd(tsAdd(lead.lastPts, lead.unit), -start.pts);
    const moved: Moved = {
      gates: new Map([...search.places].map(([from, to]) => [from, this.gate(to, false)])),
      offset: tsDiff(byPts, byDts) > 0 ? byPts : byDts,
      startPts: start.pts,
      leadOpen: false,
    };
    this.moved = moved;
    this.real = search.layout;
    this.search = undefined;
    const out = new Uint8Array(search.bytes);
    let length = 0;
    for (const [index, { pid, bytes }] of search.held.entries()) {
      const gate = moved.gates.get(pid);
      if (gate?.lead === true && index === start.index) {
        gate.open = true;
        moved.leadOpen = true;
      }
      if (gate !== undefined && this.through(moved, gate, bytes, 0)) {
        out.set(bytes, length);
        length += PACKET_BYTES;
      }
    }
    return out.subarray(0, length);
  }

  /** Whether a packet of a stream that moved is passed on. If so it is rewritten in place (see `PidMoves`). */
  private through(moved: Moved, gate: Gate, data: Uint8Array, at: number): boolean {
    const parts = packetParts(data, at);
    const { known } = gate;
    if (gate.same) {
      this.note(known, data, at, parts);
      return true;
    }
    const pes = pesStart(data, at, parts);
    if (!gate.open) {
      gate.open = !gate.lead && this.opens(moved, gate, parts, pes);
      if (!gate.open) {
        return false;
      }
    }
    data[at + 1] = ((data[at + 1] ?? 0) & 0xe0) | (gate.to >> 8);
    data[at + 2] = gate.to & 0xff;
    const header = data[at + 3] ?? 0;
    if (gate.shift === undefined && parts.adaptationAt >= 0) {
      // The stream may say that it breaks here (a new encoder does): to ffmpeg it goes on.
      data[parts.adaptationAt] = (data[parts.adaptationAt] ?? 0) & 0x7f;
    }
    // The first packet's counter goes on from the last one ffmpeg got on the PID (a packet
    // without a payload repeats it, one with a payload adds one), and the packets after it step
    // as the stream's own do: where the stream lost a packet on its way here, ffmpeg still sees
    // that one is missing.
    gate.shift ??= known.counter + ((header >> 4) & 1) - (header & 0x0f);
    data[at + 3] = (header & 0xf0) | ((header + gate.shift) & 0x0f);
    if (moved.offset !== 0) {
      if (pes !== undefined) {
        shiftPes(data, pes, moved.offset);
      }
      shiftPcr(data, parts, moved.offset);
    }
    this.note(known, data, at, parts);
    return true;
  }

  /**
   * Whether a stream other than the video starts being passed on with this packet: at the start
   * of a unit that belongs after the first picture, and after everything ffmpeg has of the stream
   * (its last unit lasts as long as the one before it did).
   */
  private opens(moved: Moved, gate: Gate, parts: PacketParts, pes: PesStart | undefined): boolean {
    const { watched } = gate.known;
    if (pes?.pts === undefined) {
      // A PID that only carries the clock, or units without a time: once the video is on. Sound
      // waits for a unit that tells its time.
      return watched === undefined && moved.leadOpen && (parts.unitStart || parts.payloadAt < 0);
    }
    const unit = watched?.unit ?? 0;
    const last = watched?.lastDts;
    const late = tsDiff(pes.pts, moved.startPts) >= -unit;
    return late && (last === undefined || tsDiff(tsAdd(pes.pts, moved.offset), tsAdd(last, unit)) >= 0);
  }

  /** ffmpeg gets this packet on a PID it knows: remembers its counter, its times and its decoder settings. */
  private note(known: Known, data: Uint8Array, at: number, parts: PacketParts): void {
    known.counter = (data[at + 3] ?? 0) & 0x0f;
    const { watched } = known;
    if (watched === undefined) {
      return;
    }
    const pes = pesStart(data, at, parts);
    if (pes !== undefined) {
      const ended = watched.reader.end();
      watched.settings = ended === undefined || ended === "" ? watched.settings : ended;
      noteTimes(watched, pes);
    }
    const settings = watched.reader.packet(data, at, parts, pes);
    watched.settings = settings === undefined || settings === "" ? watched.settings : settings;
  }
}

function newWatched(kind: StreamKind): Watched {
  const unit = kind.kind === "video" ? VIDEO_UNIT_TICKS : AUDIO_UNIT_TICKS;
  return { kind, reader: new SettingsReader(kind), settings: undefined, lastDts: undefined, lastPts: undefined, unit };
}

function noteTimes(watched: Watched, pes: PesStart): void {
  const dts = pes.dts ?? pes.pts;
  if (dts === undefined || pes.pts === undefined) {
    return;
  }
  const step = watched.lastDts === undefined ? 0 : tsDiff(dts, watched.lastDts);
  if (step > 0 && step < 90_000) {
    watched.unit = step;
  }
  watched.lastDts = dts;
  const ahead = watched.lastPts === undefined ? 1 : tsDiff(pes.pts, watched.lastPts);
  if (ahead > 0 || ahead < -RESTART_TICKS) {
    watched.lastPts = pes.pts;
  }
}
