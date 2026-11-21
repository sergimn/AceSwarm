import { concatBytes } from "./ts-fixtures.ts";

export const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const START_CODE = bytesOf("00000001");

/**
 * Decoder settings as real encoders wrote them: libx264's parameter sets for 480x270 video and its
 * sequence parameter set for 320x180, and libx265's three for 480x270.
 */
export const SETS = {
  sps: "6742c015da07823fac0440000003004000000ca3c58ba8",
  smallSps: "6742c00cda05067e7c0440000003004000000ca3c50aa8",
  pps: "68ce0fc8",
  hevcVps: "40010c01ffff01600000030090000003000003003f959409",
  hevcSps: "42010101600000030090000003000003003fa00f080447d6595952930bc05a020000030002000003003210",
  hevcPps: "4401c073c189",
};
export const H264_SETS = [SETS.sps, SETS.pps];
export const HEVC_SETS = [SETS.hevcVps, SETS.hevcSps, SETS.hevcPps];

/** Bytes of a picture or of sound: nothing in them looks like a start code. */
const filler = (length: number): Uint8Array => new Uint8Array(length).fill(0xa5);

/** NAL units one after the other, each behind a four-byte start code. */
export function nalUnits(...units: string[]): Uint8Array {
  return concatBytes(...units.flatMap((unit) => [START_CODE, bytesOf(unit)]));
}

/**
 * The first bytes of a slice, by the kind of its picture. H.264: the NAL header, then the slice
 * header's first two numbers (first macroblock 0, slice type 7 for I and 5 for P). HEVC: the two
 * header bytes of an IDR slice (type 19) and of an ordinary one (type 1).
 */
const SLICES = {
  idr: "658884",
  intra: "418884",
  p: "419a22",
  hevcIdr: "2601af",
  hevcTrail: "0201d0",
};

/** An access unit of H.264 as encoders mux it: a delimiter, the parameter sets if any, then the picture. */
export function h264Unit(picture: "idr" | "intra" | "p", sets: readonly string[] = [], bytes = 300): Uint8Array {
  return concatBytes(nalUnits("09f0", ...sets), bytesOf("000001"), bytesOf(SLICES[picture]), filler(bytes));
}

/** The same of HEVC. */
export function hevcUnit(picture: "hevcIdr" | "hevcTrail", sets: readonly string[] = [], bytes = 300): Uint8Array {
  return concatBytes(nalUnits("460150", ...sets), bytesOf("000001"), bytesOf(SLICES[picture]), filler(bytes));
}

/** One AAC frame with its ADTS header: AAC-LC, 48 kHz and one channel unless told otherwise. */
export function adtsFrame(options: { channels?: number; rateIndex?: number; privateBit?: boolean } = {}): Uint8Array {
  const { channels = 1, rateIndex = 3, privateBit = false } = options;
  const length = 96;
  const header = Uint8Array.of(
    0xff,
    0xf1,
    0x40 | (rateIndex << 2) | (privateBit ? 0x02 : 0) | (channels >> 2),
    ((channels & 0x03) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 0x07) << 5) | 0x1f,
    0xfc,
  );
  return concatBytes(header, filler(length - header.length));
}

const TOP_BITS = 2 ** 30;

/** A PES timestamp: 33 bits in five bytes, with marker bits between them. */
function timestamp(prefix: number, ts: number): number[] {
  const top = Math.floor(ts / TOP_BITS);
  const low = ts - top * TOP_BITS;
  return [
    (prefix << 4) | (top << 1) | 1,
    (low >>> 22) & 0xff,
    (((low >>> 15) & 0x7f) << 1) | 1,
    (low >>> 7) & 0xff,
    ((low & 0x7f) << 1) | 1,
  ];
}

export interface PesTimes {
  pts: number;
  /** When it is decoded, where that is not when it is shown. */
  dts?: number;
  /** A clock reference in the first packet's adaptation field. */
  pcr?: number;
  /** The first packet says that the stream breaks here on purpose. */
  discontinuity?: boolean;
}

/** Writes PES packets as MPEG-TS packets, with every PID's continuity counter going on from its last packet. */
export class TsWriter {
  private readonly counters = new Map<number, number>();

  /** The counter of the last packet with a payload written on `pid`. */
  counter(pid: number): number {
    return this.counters.get(pid) ?? -1;
  }

  /** One PES packet of `data`: video's has no length (as muxers write it), audio's has. */
  pes(pid: number, kind: "video" | "audio", data: Uint8Array, times: PesTimes): Uint8Array {
    const stamps =
      times.dts === undefined ? timestamp(2, times.pts) : [...timestamp(3, times.pts), ...timestamp(1, times.dts)];
    const length = kind === "video" ? 0 : 3 + stamps.length + data.length;
    const flags = times.dts === undefined ? 0x80 : 0xc0;
    const header = [0, 0, 1, kind === "video" ? 0xe0 : 0xc0, length >> 8, length & 0xff, 0x80, flags, stamps.length];
    const whole = concatBytes(Uint8Array.from([...header, ...stamps]), data);
    const packets: Uint8Array[] = [];
    let at = 0;
    while (at < whole.length) {
      const first = at === 0;
      // Room for the clock reference and its flags in front of the payload.
      const fixed = first && (times.pcr !== undefined || times.discontinuity === true) ? 8 : 0;
      const take = Math.min(184 - fixed, whole.length - at);
      packets.push(this.packet(pid, first, whole.subarray(at, at + take), first ? times : undefined));
      at += take;
    }
    return concatBytes(...packets);
  }

  /** A packet with only an adaptation field, as muxers send a clock reference between pictures. */
  clock(pid: number, pcr: number): Uint8Array {
    return this.packet(pid, false, new Uint8Array(0), { pcr });
  }

  private packet(
    pid: number,
    start: boolean,
    payload: Uint8Array,
    extras?: Pick<PesTimes, "pcr" | "discontinuity">,
  ): Uint8Array {
    const packet = new Uint8Array(188).fill(0xff);
    const adaptation = 184 - payload.length;
    if (payload.length > 0) {
      this.counters.set(pid, (this.counter(pid) + 1) & 0x0f);
    }
    const control = (adaptation > 0 ? 0x20 : 0) | (payload.length > 0 ? 0x10 : 0);
    packet.set([0x47, (start ? 0x40 : 0) | (pid >> 8), pid & 0xff, control | (Math.max(this.counter(pid), 0) & 0x0f)]);
    if (adaptation > 0) {
      packet[4] = adaptation - 1;
    }
    if (adaptation > 1) {
      const pcr = extras?.pcr;
      packet[5] = (pcr === undefined ? 0 : 0x10) | (extras?.discontinuity === true ? 0x80 : 0);
      if (pcr !== undefined) {
        // 33 bits of 90 kHz ticks, six reserved bits, and an extension of 27 MHz ticks (0 here).
        const high = Math.floor(pcr / 2 ** 25);
        const low = pcr - high * 2 ** 25;
        packet.set([high, (low >>> 17) & 0xff, (low >>> 9) & 0xff, (low >>> 1) & 0xff, ((low & 1) << 7) | 0x7e, 0], 6);
      }
    }
    packet.set(payload, 4 + adaptation);
    return packet;
  }
}

/** What a test reads back of one packet; written apart from the code under test. */
export interface SeenPacket {
  pid: number;
  counter: number;
  start: boolean;
  discontinuity: boolean;
  pcr: number | undefined;
  pts: number | undefined;
  dts: number | undefined;
  payload: Uint8Array;
}

function readTimestamp(bytes: Uint8Array, at: number): number {
  const byte = (index: number): number => bytes[at + index] ?? 0;
  return (
    ((byte(0) >> 1) & 0x07) * TOP_BITS + ((byte(1) << 22) | ((byte(2) >> 1) << 15) | (byte(3) << 7) | (byte(4) >> 1))
  );
}

export function readPackets(bytes: Uint8Array): SeenPacket[] {
  const seen: SeenPacket[] = [];
  for (let at = 0; at + 188 <= bytes.length; at += 188) {
    const packet = bytes.subarray(at, at + 188);
    const byte = (index: number): number => packet[index] ?? 0;
    const hasAdaptation = (byte(3) & 0x20) !== 0;
    const flags = hasAdaptation && byte(4) > 0 ? byte(5) : 0;
    const payload = (byte(3) & 0x10) === 0 ? new Uint8Array(0) : packet.subarray(hasAdaptation ? 5 + byte(4) : 4);
    const start = (byte(1) & 0x40) !== 0;
    const pes = start && payload[0] === 0 && payload[1] === 0 && payload[2] === 1;
    const stamps = pes ? (payload[7] ?? 0) >> 6 : 0;
    seen.push({
      pid: ((byte(1) & 0x1f) << 8) | byte(2),
      counter: byte(3) & 0x0f,
      start,
      discontinuity: (flags & 0x80) !== 0,
      pcr:
        (flags & 0x10) === 0
          ? undefined
          : byte(6) * 2 ** 25 + ((byte(7) << 17) | (byte(8) << 9) | (byte(9) << 1) | (byte(10) >> 7)),
      pts: stamps >= 2 ? readTimestamp(payload, 9) : undefined,
      dts: stamps === 3 ? readTimestamp(payload, 14) : undefined,
      payload,
    });
  }
  return seen;
}

/** MPEG-TS timestamps start over after 33 bits. */
export const WRAP = 2 ** 33;
/** 25 pictures a second, in 90 kHz ticks. */
export const FRAME = 3600;

export interface EncoderOptions {
  video: number;
  audio: number;
  /** Where its clock is when it starts: every encoder has its own. */
  start: number;
  sets?: readonly string[];
  codec?: "h264" | "hevc";
  sound?: () => Uint8Array;
  /** How long before it is shown a picture is decoded (an encoder that reorders pictures). */
  delay?: number;
  /** The time from one picture to the next, in 90 kHz ticks: 25 pictures a second unless told otherwise. */
  frame?: number;
}

export type Picture = "idr" | "p" | "intra";

/** An encoder: pictures at a steady pace, each followed by a frame of sound with the same time. */
export class Encoder {
  readonly writer = new TsWriter();
  pts: number;
  private readonly options: EncoderOptions;

  constructor(options: EncoderOptions) {
    this.options = options;
    this.pts = options.start;
  }

  /** The picture alone, as packets. */
  video(kind: Picture, extras: { sets?: boolean; discontinuity?: boolean } = {}): Uint8Array {
    const { codec = "h264", delay = 0 } = this.options;
    const own = this.options.sets ?? (codec === "hevc" ? HEVC_SETS : H264_SETS);
    const sets = kind === "idr" || extras.sets === true ? own : [];
    const hevc = kind === "idr" ? "hevcIdr" : "hevcTrail";
    const unit = codec === "hevc" ? hevcUnit(hevc, sets) : h264Unit(kind, sets);
    const times: PesTimes = { pts: this.pts, pcr: (this.pts - 9000 + WRAP) % WRAP };
    if (delay !== 0) {
      times.dts = (this.pts - delay + WRAP) % WRAP;
    }
    if (extras.discontinuity === true) {
      times.discontinuity = true;
    }
    return this.writer.pes(this.options.video, "video", unit, times);
  }

  /** A picture without sound that is shown at `pts` and decoded at `dts`, whatever the encoder's clock says. */
  at(kind: Picture, pts: number, dts = pts): Uint8Array {
    const unit = h264Unit(kind, kind === "idr" ? (this.options.sets ?? H264_SETS) : []);
    return this.writer.pes(this.options.video, "video", unit, dts === pts ? { pts } : { pts, dts });
  }

  /** One picture and its sound (none when `silent`); the encoder's clock moves on by a frame. */
  picture(kind: Picture, extras: { sets?: boolean; discontinuity?: boolean; silent?: boolean } = {}): Uint8Array {
    const video = this.video(kind, extras);
    const sound = (this.options.sound ?? adtsFrame)();
    const audio =
      extras.silent === true
        ? new Uint8Array(0)
        : this.writer.pes(this.options.audio, "audio", sound, { pts: this.pts });
    this.pts = (this.pts + (this.options.frame ?? FRAME)) % WRAP;
    return concatBytes(video, audio);
  }
}
