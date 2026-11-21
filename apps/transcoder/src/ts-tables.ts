import { PACKET_BYTES, SYNC_BYTE } from "./ts-packets.ts";

const PAT_PID = 0;
const NULL_PID = 0x1f_ff;
const PAT_TABLE_ID = 0x00;
const PMT_TABLE_ID = 0x02;
/** A section is at most 4096 bytes long (private ones; program tables at most 1024). */
const MAX_SECTION_BYTES = 4096;
/**
 * How long a stream may take to send the tables of the other programs its PAT lists, before its
 * layout counts as known without them: until the tables that did come have each come again this
 * many times. A stream sends all of its tables about as often, several times a second, so one
 * that still misses by then is not coming soon, and the wait is a fraction of a second whatever
 * the bitrate. A stream whose PAT lists one program, as nearly all do, never waits.
 */
const OTHER_PROGRAMS_PATIENCE_REPEATS = 3;
/** The same in packets (about 2 MB), for a stream whose tables don't come again either. */
const OTHER_PROGRAMS_PATIENCE_PACKETS = 11_000;

/** One elementary stream of a program, as its program map table (PMT) lists it. */
export interface StreamEntry {
  pid: number;
  /** The entry's `stream_type`: which kind of data the PID carries. */
  type: number;
  /** The entry's descriptors, as sent: they tell more about the data, for private stream types all of it. */
  descriptors: Uint8Array;
}

/** A program of the stream: one channel, with the PIDs that carry its video, audio and data. */
export interface Program {
  number: number;
  pmtPid: number;
  /** The PID whose packets carry the program's clock (PCR): usually its video's. */
  pcrPid: number;
  streams: StreamEntry[];
}

/**
 * What an MPEG-TS stream says it carries: its programs and their elementary streams. Two layouts
 * with the same `key` are the same to a reader of the stream's video and audio; a different one
 * means that a stream it may read moved, went, came or changed format, and that a demuxer which
 * follows the old one may lose it.
 */
export interface Layout {
  /** The programs whose tables were seen, in the order the stream lists them. */
  programs: Program[];
  /**
   * Tells layouts apart: every program's number and PMT PID, and the PID and format of every
   * stream that is, or may be, video or audio (see `formatOf`). What tells a reader of those
   * nothing is left out: streams of other data (subtitles, teletext, cue messages), and
   * descriptors that don't name a format (a language, say). A broadcast changes such details
   * without anything a reader would have to follow.
   */
  key: string;
}

/**
 * Video stream types, by the name ffmpeg gives the codec. Anything else is either not video or
 * not known here: what a private stream (type 6) carries is in its descriptors.
 */
const VIDEO_TYPES: ReadonlyMap<number, string> = new Map([
  [0x01, "mpeg1video"],
  [0x02, "mpeg2video"],
  [0x10, "mpeg4"],
  [0x1b, "h264"],
  [0x20, "h264"],
  [0x24, "hevc"],
  [0x33, "vvc"],
  [0x42, "cavs"],
  [0xd1, "dirac"],
  [0xd2, "avs2"],
  [0xd4, "avs3"],
  [0xea, "vc1"],
]);

/** Private streams that say what they are in a registration descriptor (tag 5), by its four letters. */
const VIDEO_REGISTRATIONS: ReadonlyMap<string, string> = new Map([
  ["HEVC", "hevc"],
  ["VVC ", "vvc"],
  ["VC-1", "vc1"],
  ["drac", "dirac"],
  ["AV01", "av1"],
  ["VP90", "vp9"],
]);

const REGISTRATION_DESCRIPTOR = 0x05;
const PRIVATE_STREAM_TYPE = 0x06;
/**
 * Descriptors that name the format of a private stream (type 6) which is audio: AC-3, E-AC-3,
 * DTS and AAC, and the extension descriptor newer formats use. A registration descriptor names
 * any format by four letters.
 */
const AUDIO_DESCRIPTORS = new Set([0x6a, 0x7a, 0x7b, 0x7c, 0x7f]);
/** Descriptors of private streams that are neither video nor audio: VBI data, teletext, subtitles. */
const DATA_DESCRIPTORS = new Set([0x45, 0x46, 0x56, 0x59]);
/** Stream types that are neither: private sections, DSM-CC, metadata, cue messages (SCTE-35). */
const DATA_TYPES = new Set([0x05, 0x0a, 0x0b, 0x0c, 0x0d, 0x15, 0x86]);

/** The codec of a stream entry that is known to be video, as ffmpeg names it; undefined otherwise. */
export function videoCodecOf(entry: StreamEntry): string | undefined {
  const known = VIDEO_TYPES.get(entry.type);
  if (known !== undefined || entry.type !== PRIVATE_STREAM_TYPE) {
    return known;
  }
  const { descriptors } = entry;
  for (let at = 0; at + 2 <= descriptors.length; at += 2 + (descriptors[at + 1] ?? 0)) {
    if (descriptors[at] === REGISTRATION_DESCRIPTOR && (descriptors[at + 1] ?? 0) >= 4) {
      const letters = String.fromCodePoint(...descriptors.subarray(at + 2, at + 6));
      return VIDEO_REGISTRATIONS.get(letters);
    }
  }
  return undefined;
}

/** The layout's first stream known to be video: the one a reader takes when it is asked for "the video". */
function firstVideo(layout: Layout): { pid: number; codec: string } | undefined {
  for (const program of layout.programs) {
    for (const entry of program.streams) {
      const codec = videoCodecOf(entry);
      if (codec !== undefined) {
        return { pid: entry.pid, codec };
      }
    }
  }
  return undefined;
}

/**
 * The codec of the layout's first video stream, the one a reader takes when it is asked for "the
 * video": undefined when no stream is known to be video (the reader may still find one).
 */
export function videoCodecOfLayout(layout: Layout): string | undefined {
  return firstVideo(layout)?.codec;
}

/** What changed between two layouts, as far as the video goes: its codec, only its PID, or something else. */
export type LayoutChangeKind = "codec" | "pid" | "other";

export function changeKind(previous: Layout, next: Layout): LayoutChangeKind {
  const before = firstVideo(previous);
  const after = firstVideo(next);
  if (before?.codec !== after?.codec) {
    return "codec";
  }
  return before?.pid === after?.pid ? "other" : "pid";
}

/** Every PID the layout's programs use for their streams. */
export function streamPids(layout: Layout): Set<number> {
  return new Set(layout.programs.flatMap((program) => program.streams.map((entry) => entry.pid)));
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString("hex");

/**
 * What a demuxer takes a stream entry for, as far as its tables tell: its type, and the
 * descriptors that name a format (the others say things like the language, which no reader has
 * to follow). Undefined for a stream that is known to be neither video nor audio.
 */
export function formatOf(entry: StreamEntry): string | undefined {
  const { descriptors, type } = entry;
  const names: string[] = [];
  let data = false;
  for (let at = 0; at + 2 <= descriptors.length; at += 2 + (descriptors[at + 1] ?? 0)) {
    const tag = descriptors[at] ?? 0;
    if (tag === REGISTRATION_DESCRIPTOR) {
      names.push(hex(descriptors.subarray(at, at + 6)));
    } else if (AUDIO_DESCRIPTORS.has(tag)) {
      names.push(tag.toString(16));
    }
    data ||= DATA_DESCRIPTORS.has(tag);
  }
  // A private stream is data when a descriptor says so and none names a format.
  const isData = DATA_TYPES.has(type) || (type === PRIVATE_STREAM_TYPE && data && names.length === 0);
  return isData ? undefined : `${String(type)}:${names.join("+")}`;
}

function keyOf(programs: readonly Program[]): string {
  return programs
    .map((program) => {
      const streams = program.streams.flatMap((entry) => {
        const format = formatOf(entry);
        return format === undefined ? [] : `${String(entry.pid)}:${format}`;
      });
      return `${String(program.number)}@${String(program.pmtPid)}[${streams.join(",")}]`;
    })
    .join(";");
}

function sameBytes(a: Uint8Array, b: Uint8Array | undefined): boolean {
  return a.length === b?.length && a.every((byte, index) => byte === b[index]);
}

/** A short description of a layout for logs: per program, its streams as `pid:type` (and the codec of video). */
export function describeLayout(layout: Layout): string {
  return layout.programs
    .map((program) => {
      const streams = program.streams.map((entry) => {
        const codec = videoCodecOf(entry);
        const type = `0x${entry.type.toString(16).padStart(2, "0")}`;
        return `${String(entry.pid)}:${codec ?? type}`;
      });
      return `program ${String(program.number)} [${streams.join(" ")}]`;
    })
    .join("; ");
}

/** CRC-32/MPEG-2, which ends every table section: over the whole section, a valid one gives 0. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 0x80_00_00_00) === 0 ? crc << 1 : (crc << 1) ^ 0x04_c1_1d_b7;
  }
  return crc >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  return crc;
}

/** Puts together the table sections one PID carries, which can span packets. */
class Sections {
  private buffer = new Uint8Array(MAX_SECTION_BYTES);
  private length = 0;
  /** Whether the bytes in `buffer` begin at the start of a section. */
  private started = false;
  private lastCounter = -1;

  /** Feeds one packet's payload, and returns the sections it completed that pass their CRC. */
  push(payload: Uint8Array, unitStart: boolean, counter: number): Uint8Array[] {
    const follows = this.lastCounter === -1 || counter === ((this.lastCounter + 1) & 0x0f);
    this.lastCounter = counter;
    if (!follows) {
      // A packet was lost: what was collected so far can't be completed.
      this.reset();
    }
    const done: Uint8Array[] = [];
    let rest = payload;
    if (unitStart) {
      // The first byte says where a new section begins; before it comes the end of the last one.
      const pointer = payload[0] ?? 0;
      if (1 + pointer > payload.length) {
        this.reset();
        return done;
      }
      if (this.started) {
        this.append(payload.subarray(1, 1 + pointer));
        this.take(done);
      }
      this.reset();
      this.started = true;
      rest = payload.subarray(1 + pointer);
    } else if (!this.started) {
      return done;
    }
    this.append(rest);
    this.take(done);
    return done;
  }

  private reset(): void {
    this.length = 0;
    this.started = false;
  }

  private append(bytes: Uint8Array): void {
    const room = this.buffer.length - this.length;
    const part = bytes.length > room ? bytes.subarray(0, room) : bytes;
    this.buffer.set(part, this.length);
    this.length += part.length;
  }

  /** Moves every complete section at the start of the buffer to `done`. */
  private take(done: Uint8Array[]): void {
    for (;;) {
      // 0xff where a section would begin is stuffing: nothing more comes in this packet.
      if (this.length < 3 || this.buffer[0] === 0xff) {
        if (this.buffer[0] === 0xff) {
          this.reset();
        }
        return;
      }
      const size = 3 + ((((this.buffer[1] ?? 0) & 0x0f) << 8) | (this.buffer[2] ?? 0));
      if (size > this.buffer.length) {
        this.reset();
        return;
      }
      if (this.length < size) {
        return;
      }
      const section = this.buffer.slice(0, size);
      if (size >= 12 && crc32(section) === 0) {
        done.push(section);
      }
      this.buffer.copyWithin(0, size, this.length);
      this.length -= size;
    }
  }
}

/** A section header's fields that every program table has. */
function tableHeader(section: Uint8Array): { tableId: number; id: number; current: boolean } {
  return {
    tableId: section[0] ?? 0xff,
    id: ((section[3] ?? 0) << 8) | (section[4] ?? 0),
    // A table sent ahead of time (not "current") says what comes next, not what is there now.
    current: ((section[5] ?? 0) & 0x01) === 1,
  };
}

/**
 * Follows the program tables (PAT and PMTs) of an MPEG-TS stream, packet by packet, and tells
 * what the stream carries now (see `Layout`). Only what the tables say counts, not their version
 * numbers: a broadcast can move its video to other PIDs or another codec and send the new table
 * under the old version. Every section is checked against its CRC, so a damaged one changes nothing.
 */
export class TsTables {
  /** The PAT's programs, in its order: program number to PMT PID. */
  private pat = new Map<number, number>();
  /** The PIDs that carry tables: the PAT's, and the PMT PIDs it lists. */
  private tablePids = new Set<number>([PAT_PID]);
  private readonly programs = new Map<number, Program>();
  private readonly sections = new Map<number, Sections>();
  private current: Layout | undefined;
  /** Packets since the first program's table came while others are still missing. */
  private waited = 0;
  /** How many times a table that is known came again meanwhile. */
  private repeats = 0;
  /** The PAT and PMT sections as they came, to start a reader with (see `tablePackets`). */
  private patSection: Uint8Array | undefined;
  private readonly pmtSections = new Map<number, Uint8Array>();

  /** What the stream carries, once its tables came; undefined before. */
  get layout(): Layout | undefined {
    return this.current;
  }

  /** Whether the PID carries program tables (the PAT, or a PMT it lists), not a stream's data. */
  carriesTables(pid: number): boolean {
    return this.tablePids.has(pid);
  }

  /**
   * Feeds the packet at `at` in `data`. Returns the stream's layout when this packet made it known
   * or changed it, undefined otherwise.
   */
  packet(data: Uint8Array, at: number): Layout | undefined {
    const flags = data[at + 1] ?? 0;
    const pid = ((flags & 0x1f) << 8) | (data[at + 2] ?? 0);
    if (this.current === undefined && this.programs.size > 0) {
      this.waited += 1;
    }
    if (!this.tablePids.has(pid) || (flags & 0x80) !== 0) {
      return this.current === undefined && this.waited >= OTHER_PROGRAMS_PATIENCE_PACKETS ? this.settle() : undefined;
    }
    const control = data[at + 3] ?? 0;
    const hasPayload = (control & 0x10) !== 0;
    const hasAdaptation = (control & 0x20) !== 0;
    const payloadAt = at + 4 + (hasAdaptation ? 1 + (data[at + 4] ?? 0) : 0);
    if (!hasPayload || payloadAt >= at + PACKET_BYTES) {
      return undefined;
    }
    let sections = this.sections.get(pid);
    if (sections === undefined) {
      sections = new Sections();
      this.sections.set(pid, sections);
    }
    const payload = data.subarray(payloadAt, at + PACKET_BYTES);
    let changed = false;
    const complete = sections.push(payload, (flags & 0x40) !== 0, control & 0x0f);
    for (const section of complete) {
      changed = (pid === PAT_PID ? this.onPat(section) : this.onPmt(pid, section)) || changed;
    }
    // Without a layout yet, a table that came again may be what ends the wait for the others.
    return changed || this.current === undefined ? this.settle() : undefined;
  }

  private onPat(section: Uint8Array): boolean {
    const header = tableHeader(section);
    // A PAT in more than one section (it takes hundreds of programs) is left alone: each section
    // would look like the whole table. Such a stream's layout stays unknown, and readers get it
    // as it comes.
    const sections = 1 + (section[7] ?? 0);
    if (header.tableId !== PAT_TABLE_ID || !header.current || sections > 1) {
      return false;
    }
    const pat = new Map<number, number>();
    for (let at = 8; at + 4 <= section.length - 4; at += 4) {
      const number = ((section[at] ?? 0) << 8) | (section[at + 1] ?? 0);
      const pid = (((section[at + 2] ?? 0) & 0x1f) << 8) | (section[at + 3] ?? 0);
      // Program 0 points at the network table, which is no program.
      if (number !== 0 && pid !== PAT_PID && pid !== NULL_PID) {
        pat.set(number, pid);
      }
    }
    const same = pat.size === this.pat.size && pat.entries().every(([number, pid]) => this.pat.get(number) === pid);
    this.patSection = section;
    if (same) {
      return false;
    }
    this.pat = pat;
    this.repeats = 0;
    this.tablePids = new Set([PAT_PID, ...pat.values()]);
    for (const [number, program] of this.programs) {
      if (pat.get(number) !== program.pmtPid) {
        this.programs.delete(number);
        this.pmtSections.delete(number);
      }
    }
    for (const pid of this.sections.keys()) {
      if (!this.tablePids.has(pid)) {
        this.sections.delete(pid);
      }
    }
    return true;
  }

  /** Takes a PMT section. Returns whether it says anything else than the program's last one. */
  private onPmt(pid: number, section: Uint8Array): boolean {
    const header = tableHeader(section);
    if (header.tableId !== PMT_TABLE_ID || !header.current || this.pat.get(header.id) !== pid) {
      return false;
    }
    if (this.programs.has(header.id) && sameBytes(section, this.pmtSections.get(header.id))) {
      // The same table again, as it comes several times a second.
      this.repeats += 1;
      return false;
    }
    const end = section.length - 4;
    const pcrPid = (((section[8] ?? 0) & 0x1f) << 8) | (section[9] ?? 0);
    const programInfo = (((section[10] ?? 0) & 0x0f) << 8) | (section[11] ?? 0);
    const streams: StreamEntry[] = [];
    let at = 12 + programInfo;
    if (at > end) {
      // Too short for a program table, or its own lengths don't add up: see below.
      return false;
    }
    while (at + 5 <= end) {
      const infoLength = (((section[at + 3] ?? 0) & 0x0f) << 8) | (section[at + 4] ?? 0);
      if (at + 5 + infoLength > end) {
        // The section is valid by its CRC but doesn't add up: leave what is known as it is.
        return false;
      }
      streams.push({
        type: section[at] ?? 0,
        pid: (((section[at + 1] ?? 0) & 0x1f) << 8) | (section[at + 2] ?? 0),
        descriptors: section.slice(at + 5, at + 5 + infoLength),
      });
      at += 5 + infoLength;
    }
    if (streams.length === 0) {
      // A program without streams gives a reader nothing to go on: what is known stays.
      return false;
    }
    this.programs.set(header.id, { number: header.id, pmtPid: pid, pcrPid, streams });
    this.pmtSections.set(header.id, section);
    return true;
  }

  /**
   * Makes the layout what the tables say now, and returns it when it is known and differs from
   * the one before for a reader (see `Layout.key`): a change of details that tell a reader nothing
   * is kept, and is no change.
   */
  private settle(): Layout | undefined {
    const programs = this.pat
      .keys()
      .map((number) => this.programs.get(number))
      .filter((program) => program !== undefined)
      .toArray();
    if (programs.length === 0) {
      return undefined;
    }
    // Until every program the PAT lists has its table, the picture is incomplete: wait a little
    // for the rest, so that a stream with several programs doesn't change layout as they come in.
    const patient =
      this.repeats < OTHER_PROGRAMS_PATIENCE_REPEATS * programs.length && this.waited < OTHER_PROGRAMS_PATIENCE_PACKETS;
    if (this.current === undefined && programs.length < this.pat.size && patient) {
      return undefined;
    }
    const key = keyOf(programs);
    const changed = this.current?.key !== key;
    this.current = { programs, key };
    return changed ? this.current : undefined;
  }

  /**
   * The PAT and the PMTs of the current layout as packets of their own, to put in front of what a
   * new reader gets: it then knows the stream's layout from its first bytes, wherever in the
   * stream it starts. Empty before the layout is known.
   */
  tablePackets(): Uint8Array {
    const layout = this.current;
    if (layout === undefined || this.patSection === undefined) {
      return new Uint8Array(0);
    }
    const parts = [packetsOf(PAT_PID, this.patSection)];
    for (const program of layout.programs) {
      const section = this.pmtSections.get(program.number);
      if (section !== undefined) {
        parts.push(packetsOf(program.pmtPid, section));
      }
    }
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    return joined;
  }
}

/**
 * Tells when the layout of the stream it is fed changes mid-stream, for a reader that only needs
 * to know that it did. The first layout it learns of is no change.
 */
export class LayoutChanges {
  private readonly tables = new TsTables();
  private known = false;
  private pending = false;

  /** Feeds one packet, as `TsTables.packet` (a visitor for `TsPackets.push`). */
  readonly packet = (data: Uint8Array, at: number): void => {
    if (this.tables.packet(data, at) === undefined) {
      return;
    }
    this.pending ||= this.known;
    this.known = true;
  };

  /** Whether the layout changed since this was last asked. */
  changed(): boolean {
    const changed = this.pending;
    this.pending = false;
    return changed;
  }
}

/** A section as packets on `pid`: the first says where the section starts, the last is stuffed with 0xff. */
function packetsOf(pid: number, section: Uint8Array): Uint8Array {
  const payloadBytes = PACKET_BYTES - 4;
  // One more byte in the first packet: the pointer to the section's start.
  const count = Math.ceil((section.length + 1) / payloadBytes);
  const packets = new Uint8Array(count * PACKET_BYTES).fill(0xff);
  let taken = 0;
  for (let index = 0; index < count; index += 1) {
    const at = index * PACKET_BYTES;
    packets[at] = SYNC_BYTE;
    packets[at + 1] = (index === 0 ? 0x40 : 0) | ((pid >> 8) & 0x1f);
    packets[at + 2] = pid & 0xff;
    packets[at + 3] = 0x10 | (index & 0x0f);
    let room = payloadBytes;
    let to = at + 4;
    if (index === 0) {
      packets[to] = 0;
      to += 1;
      room -= 1;
    }
    const part = section.subarray(taken, taken + room);
    packets.set(part, to);
    taken += part.length;
  }
  return packets;
}
