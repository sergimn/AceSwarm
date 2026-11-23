import { describe, expect, it } from "vitest";
import { PidMoves, placesOf, staysPut, type MoveFailure, type PacketVerdict } from "../src/pid-moves.ts";
import { TsTables, type Layout } from "../src/ts-tables.ts";
import {
  adtsFrame,
  Encoder,
  FRAME,
  readPackets,
  SETS,
  TsWriter,
  WRAP,
  type EncoderOptions,
  type SeenPacket,
} from "./es-fixtures.ts";
import { concatBytes, pmtPackets, tablePackets, type TableStream } from "./ts-fixtures.ts";

const PMT_PID = 0x10_00;

const H264: TableStream[] = [
  { pid: 256, type: 0x1b },
  { pid: 257, type: 0x0f },
];
const MOVED: TableStream[] = [
  { pid: 211, type: 0x1b },
  { pid: 221, type: 0x0f },
];
const MOVED_AGAIN: TableStream[] = [
  { pid: 311, type: 0x1b },
  { pid: 321, type: 0x0f },
];

/** The layout a reader learns from the tables of these streams. */
function layoutOf(streams: readonly TableStream[], pmtPid = PMT_PID): Layout {
  const tables = new TsTables();
  const packets = tablePackets(streams, pmtPid);
  let layout: Layout | undefined;
  for (let at = 0; at < packets.length; at += 188) {
    layout = tables.packet(packets, at) ?? layout;
  }
  if (layout === undefined) {
    throw new Error("the tables gave no layout");
  }
  return layout;
}

/** The same layout with its clock reference on a PID of its own. */
function withClockOn(layout: Layout, pcrPid: number): Layout {
  return { ...layout, programs: layout.programs.map((program) => ({ ...program, pcrPid })) };
}

const BASE = layoutOf(H264);
const NEXT = layoutOf(MOVED);
/** Both with the clock reference on a PID of its own, and with none at all (PID 0x1fff). */
const BASE_CLOCKED = withClockOn(BASE, 300);
const NEXT_CLOCKED = withClockOn(NEXT, 400);
const BASE_UNCLOCKED = withClockOn(BASE, 0x1f_ff);
const NEXT_UNCLOCKED = withClockOn(NEXT, 0x1f_ff);

const hevcStreams = (video: number, audio: number): TableStream[] => [
  { pid: video, type: 0x24 },
  { pid: audio, type: 0x0f },
];
/** MPEG-2 video: its decoder settings are not read here. */
const mpeg2Streams = (video: number, audio: number): TableStream[] => [
  { pid: video, type: 0x02 },
  { pid: audio, type: 0x0f },
];
const twoVideos = (first: number): TableStream[] => [
  { pid: first, type: 0x1b },
  { pid: first + 1, type: 0x1b },
];
/** Sound as AAC in LATM: its frames are not read here. */
const latmStreams = (video: number, audio: number): TableStream[] => [
  { pid: video, type: 0x1b },
  { pid: audio, type: 0x11 },
];
/** Teletext beside the video and the sound: a stream no decoder here reads. */
const TELETEXT = [0x56, 5, 0x65, 0x6e, 0x67, 0x09, 0x00];
const withText = (video: number, audio: number, text: number): TableStream[] => [
  { pid: video, type: 0x1b },
  { pid: audio, type: 0x0f },
  { pid: text, type: 0x06, descriptors: TELETEXT },
];
const TEXT_BASE = layoutOf(withText(256, 257, 258));
const TEXT_NEXT = layoutOf(withText(211, 221, 222));
/** A unit of such a stream, of `bytes` bytes, shown at `pts`. */
const textUnit = (writer: TsWriter, pid: number, pts: number, bytes = 40): Uint8Array =>
  writer.pes(pid, "audio", new Uint8Array(bytes).fill(0x15), { pts });
/** The same packet with another continuity counter, or with the mark of a break in the stream. */
const withCounter = (packet: Uint8Array, counter: number): Uint8Array =>
  Uint8Array.from(packet, (byte, index) => (index === 3 ? (byte & 0xf0) | counter : byte));
const withBreak = (packet: Uint8Array): Uint8Array =>
  Uint8Array.from(packet, (byte, index) => (index === 5 ? byte | 0x80 : byte));

const original = (): Encoder => new Encoder({ video: 256, audio: 257, start: 900_000 });
const moved = (options: Partial<EncoderOptions> = {}): Encoder =>
  new Encoder({ video: 211, audio: 221, start: 5_000_000, ...options });

const isFailure = (verdict: PacketVerdict): verdict is MoveFailure =>
  typeof verdict === "object" && "failed" in verdict;

/** An ffmpeg run on `layout`, and what it gets of the stream a test feeds. */
function runOn(layout: Layout) {
  const clock = { now: 0 };
  const moves = new PidMoves(() => clock.now);
  moves.begin(layout);
  const got: Uint8Array[] = [];
  /** Feeds packets as the reader does; `tablePids` are the PIDs the stream's tables are on by now. */
  const feed = (bytes: Uint8Array, tablePids: readonly number[] = [0, PMT_PID]): PacketVerdict[] => {
    // The reader lets a packet be rewritten in place: the test's own bytes stay as they are.
    const copy = Uint8Array.from(bytes);
    const verdicts: PacketVerdict[] = [];
    for (let at = 0; at + 188 <= copy.length; at += 188) {
      const pid = (((copy[at + 1] ?? 0) & 0x1f) << 8) | (copy[at + 2] ?? 0);
      const verdict = moves.packet(copy, at, pid, tablePids.includes(pid));
      verdicts.push(verdict);
      if (verdict === "pass") {
        got.push(copy.slice(at, at + 188));
      } else if (typeof verdict === "object" && "carried" in verdict) {
        got.push(Uint8Array.from(verdict.carried));
      }
    }
    return verdicts;
  };
  /** Feeds packets, and tells the kinds of verdict they got, each once. */
  const kinds = (bytes: Uint8Array, tablePids?: readonly number[]): string[] => {
    const all = feed(bytes, tablePids).map((verdict) => {
      if (typeof verdict === "string") {
        return verdict;
      }
      return "carried" in verdict ? "carried" : "failed";
    });
    return [...new Set(all)].toSorted((a, b) => a.localeCompare(b));
  };
  return { clock, moves, feed, kinds, got: (): SeenPacket[] => readPackets(concatBytes(...got)) };
}

/** A run that has read three pictures of the original encoder. */
function playing(layout = BASE, encoder = original()) {
  const run = runOn(layout);
  const first = concatBytes(encoder.picture("idr"), encoder.picture("p"), encoder.picture("p"));
  expect(run.kinds(first)).toEqual(["pass"]);
  return { run, encoder, before: run.got().length };
}

const starts = (packets: readonly SeenPacket[], pid: number): SeenPacket[] =>
  packets.filter((packet) => packet.pid === pid && packet.start);

/** Whether each PID's continuity counter goes up by one with every packet that has a payload. */
function countersContinue(packets: readonly SeenPacket[]): boolean {
  const last = new Map<number, number>();
  for (const packet of packets) {
    if (packet.payload.length === 0) {
      continue;
    }
    const before = last.get(packet.pid);
    if (before !== undefined && packet.counter !== ((before + 1) & 0x0f)) {
      return false;
    }
    last.set(packet.pid, packet.counter);
  }
  return true;
}

describe("placesOf", () => {
  it("maps the same streams on other PIDs to the ones they take the place of", () => {
    expect(placesOf(BASE, NEXT)).toEqual(
      new Map([
        [211, 256],
        [221, 257],
      ]),
    );
    // Nothing moved: every PID is its own place.
    expect(placesOf(BASE, layoutOf(H264, 0x10_01))).toEqual(
      new Map([
        [256, 256],
        [257, 257],
      ]),
    );
  });

  it("goes by the order of the streams, and leaves out streams of other data", () => {
    const subtitles = {
      pid: 300,
      type: 0x06,
      descriptors: [0x59, 0x08, 0x65, 0x6e, 0x67, 0x10, 0x00, 0x01, 0x00, 0x01],
    };
    const next = layoutOf([{ pid: 211, type: 0x1b }, subtitles, { pid: 221, type: 0x0f }]);
    expect(placesOf(BASE, next)).toEqual(
      new Map([
        [211, 256],
        [221, 257],
      ]),
    );
  });

  it("finds a place for a clock reference on a PID of its own", () => {
    const places = placesOf(BASE_CLOCKED, NEXT_CLOCKED);
    expect(places?.get(400)).toBe(300);
    // On a stream in one layout and on its own PID in the other: not the same streams.
    expect(placesOf(BASE, NEXT_CLOCKED)).toBeUndefined();
    // On the video in one and on the audio in the other.
    expect(placesOf(BASE, withClockOn(NEXT, 221))).toBeUndefined();
    // No clock reference at all (PID 0x1fff) in one of them, either way round; in neither is fine.
    expect(placesOf(BASE, NEXT_UNCLOCKED)).toBeUndefined();
    expect(placesOf(BASE_UNCLOCKED, NEXT_CLOCKED)).toBeUndefined();
    expect(placesOf(BASE_UNCLOCKED, NEXT_UNCLOCKED)?.get(211)).toBe(256);
  });

  it("is none for streams of another format, more or fewer streams, or more programs", () => {
    const hevc = layoutOf(hevcStreams(211, 221));
    expect(placesOf(BASE, hevc)).toBeUndefined();
    const videoOnly = layoutOf([{ pid: 211, type: 0x1b }]);
    expect(placesOf(BASE, videoOnly)).toBeUndefined();
    const moreSound = layoutOf([...MOVED, { pid: 222, type: 0x0f }]);
    expect(placesOf(BASE, moreSound)).toBeUndefined();
    // The audio in front of the video: the first stream is not the same kind as it was.
    const swapped = layoutOf([
      { pid: 221, type: 0x0f },
      { pid: 211, type: 0x1b },
    ]);
    expect(placesOf(BASE, swapped)).toBeUndefined();
    const twoPrograms: Layout = { ...BASE, programs: [...BASE.programs, ...NEXT.programs] };
    expect(placesOf(BASE, twoPrograms)).toBeUndefined();
  });
});

describe("staysPut", () => {
  const video = { pid: 256, type: 0x1b };
  const sound = { pid: 257, type: 0x0f };
  const more = { pid: 300, type: 0x0f };
  /** E-AC-3 sound in a private stream: a stream that may be sound, of a kind not read here. */
  const unknown = { pid: 310, type: 0x06, descriptors: [0x7a, 0x01, 0x00] };

  it("holds when only the tables changed", () => {
    expect(staysPut(BASE, layoutOf(H264, 0x10_01))).toBe(true);
    expect(staysPut(BASE, BASE)).toBe(true);
    expect(staysPut(BASE, NEXT)).toBe(false);
  });

  it("holds while the first video and the first audio stream are where they were, whatever comes and goes", () => {
    const both = layoutOf([video, sound]);
    const three = layoutOf([video, sound, more]);
    // A second audio stream comes, behind the first one or in front of it, and goes.
    expect(staysPut(both, three)).toBe(true);
    expect(staysPut(both, layoutOf([video, more, sound]))).toBe(true);
    expect(staysPut(three, both)).toBe(true);
    // It moves to another PID, or turns into a kind of stream not known here.
    expect(staysPut(three, layoutOf([video, sound, { pid: 301, type: 0x0f }]))).toBe(true);
    expect(staysPut(three, layoutOf([video, sound, unknown]))).toBe(true);
    // A second video stream comes.
    expect(staysPut(both, layoutOf([video, { pid: 258, type: 0x1b }, sound]))).toBe(true);
  });

  it("does not hold when a stream ffmpeg reads is gone, moved, or of another format", () => {
    const three = layoutOf([video, sound, more]);
    // The first audio stream goes: the run's sound would end.
    expect(staysPut(three, layoutOf([video, more]))).toBe(false);
    expect(staysPut(three, layoutOf([video, { pid: 221, type: 0x0f }, more]))).toBe(false);
    expect(staysPut(three, layoutOf([{ pid: 211, type: 0x1b }, sound, more]))).toBe(false);
    expect(staysPut(three, layoutOf([video, { pid: 257, type: 0x03 }, more]))).toBe(false);
    expect(staysPut(three, layoutOf([{ pid: 256, type: 0x24 }, sound, more]))).toBe(false);
  });

  it("does not hold when a kind of stream begins that the run has none of", () => {
    const silent = layoutOf([video]);
    // Sound begins, or what may be sound: only a new run takes it.
    expect(staysPut(silent, layoutOf([video, sound]))).toBe(false);
    expect(staysPut(silent, layoutOf([video, unknown]))).toBe(false);
    expect(staysPut(layoutOf([sound]), layoutOf([video, sound]))).toBe(false);
    // More of what it has is none of that.
    expect(staysPut(silent, layoutOf([video, { pid: 258, type: 0x1b }]))).toBe(true);
    expect(staysPut(layoutOf([sound]), layoutOf([sound, more]))).toBe(true);
  });

  it("wants every stream where it was, and none new, where the tables don't tell which ones ffmpeg reads", () => {
    // A stream of a kind not known here may be the first sound.
    const mixed = layoutOf([video, unknown, sound]);
    expect(staysPut(mixed, layoutOf([video, unknown, sound], 0x10_01))).toBe(true);
    expect(staysPut(mixed, layoutOf([video, unknown, sound, more]))).toBe(false);
    expect(staysPut(mixed, layoutOf([video, sound]))).toBe(false);
    // MPEG-2 video is video, but its kind is not read here either.
    const mpeg2 = mpeg2Streams(256, 257);
    const old = layoutOf(mpeg2);
    expect(staysPut(old, layoutOf(mpeg2, 0x10_01))).toBe(true);
    expect(staysPut(old, layoutOf([...mpeg2, more]))).toBe(false);
    // Two programs: which one's streams ffmpeg takes depends on how their tables come.
    const second = (streams: TableStream[]): Layout => {
      const program = { number: 2, pmtPid: 0x10_02, pcrPid: 500, streams: layoutOf(streams).programs[0]!.streams };
      return { key: "two programs", programs: [BASE.programs[0]!, program] };
    };
    const other = { pid: 500, type: 0x1b };
    expect(staysPut(second([other]), second([other]))).toBe(true);
    expect(staysPut(second([other]), second([other, more]))).toBe(false);
  });
});

describe("PidMoves", () => {
  it("carries a run over a move to other PIDs, from the first picture a decoder can start at", () => {
    const { run, encoder, before } = playing();
    const lastPts = encoder.pts - FRAME;
    expect(run.moves.consider(NEXT)).toBe("looking");

    // The new encoder is joined in the middle of a group of pictures, on a clock of its own.
    const next = moved();
    expect(run.kinds(next.picture("p"))).toEqual(["hold"]);
    expect(run.got()).toHaveLength(before);
    const idr = next.picture("idr", { discontinuity: true });
    const verdicts = run.feed(idr);
    // The move is on with the first packet of the picture: its start says all there is to know.
    expect(verdicts[0]).toHaveProperty("carried");
    expect(new Set(verdicts.slice(1))).toEqual(new Set(["pass"]));

    const after = run.got().slice(before);
    // Everything ffmpeg gets is on the PIDs it knows.
    expect(new Set(after.map((packet) => packet.pid))).toEqual(new Set([256, 257]));
    // The picture that needs earlier ones was left out: the first one is the one with the settings.
    const pictures = starts(after, 256);
    expect(pictures).toHaveLength(1);
    expect(Buffer.from(after[0]!.payload).toString("hex")).toContain(SETS.sps);
    // Its time goes on one frame after the last picture ffmpeg got, whatever the new encoder's clock says.
    expect(pictures[0]).toMatchObject({ pts: lastPts + FRAME, pcr: lastPts + FRAME - 9000, discontinuity: false });
    // So does the sound: the frame that came with the picture left out is left out too.
    expect(starts(after, 257).map((packet) => packet.pts)).toEqual([lastPts + FRAME]);
    // Each PID's counter goes on where the old stream's stopped.
    expect(countersContinue(run.got())).toBe(true);
    // Apart from the header, the packets are what the encoder sent.
    const sent = readPackets(idr);
    expect(after.map((packet) => packet.payload.subarray(packet.start ? 14 : 0))).toEqual(
      sent.map((packet) => packet.payload.subarray(packet.start ? 14 : 0)),
    );

    // From here on its packets pass as they come, rewritten the same way. A break the stream
    // announces later is its own, and ffmpeg is told.
    const more = concatBytes(next.picture("p"), next.picture("p", { discontinuity: true }));
    expect(run.kinds(more)).toEqual(["pass"]);
    expect(starts(run.got(), 256).map((packet) => packet.discontinuity)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    const all = run.got();
    expect(new Set(all.slice(before).map((packet) => packet.pid))).toEqual(new Set([256, 257]));
    expect(starts(all.slice(before), 256).map((packet) => packet.pts)).toEqual([
      lastPts + FRAME,
      lastPts + 2 * FRAME,
      lastPts + 3 * FRAME,
    ]);
    expect(starts(all.slice(before), 257).map((packet) => packet.pts)).toEqual([
      lastPts + FRAME,
      lastPts + 2 * FRAME,
      lastPts + 3 * FRAME,
    ]);
    expect(countersContinue(all)).toBe(true);
  });

  it("gives ffmpeg what the old encoder still sends while it looks, and nothing of it once the move is on", () => {
    const { run, encoder, before } = playing();
    expect(run.moves.consider(NEXT)).toBe("looking");
    const next = moved();
    run.feed(next.picture("p"));
    // The old encoder's last picture comes after the tables changed.
    expect(run.kinds(encoder.picture("p"))).toEqual(["pass"]);
    const lastPts = encoder.pts - FRAME;
    run.feed(next.picture("idr"));
    // The new stream goes on after that picture, not after the last one before the change.
    expect(starts(run.got().slice(before), 256).map((packet) => packet.pts)).toEqual([lastPts, lastPts + FRAME]);
    expect(countersContinue(run.got())).toBe(true);

    const length = run.got().length;
    expect(run.kinds(encoder.picture("p"))).toEqual(["drop"]);
    expect(run.got()).toHaveLength(length);
  });

  it("goes on from a picture coded by itself that the stream marks as a point to start at, as encoders without IDR pictures send them", () => {
    const { run, encoder, before } = playing();
    const lastPts = encoder.pts - FRAME;
    run.moves.consider(NEXT);
    const next = moved();
    // The settings in front of a picture that needs earlier ones: no place to start. Nor is a
    // picture coded by itself that the stream doesn't mark: what follows may need what came before it.
    expect(run.kinds(next.picture("p", { sets: true }))).toEqual(["hold"]);
    expect(run.kinds(next.picture("i", { sets: true }))).toEqual(["hold"]);
    expect(run.feed(next.picture("intra", { sets: true }))[0]).toHaveProperty("carried");
    expect(starts(run.got().slice(before), 256).map((packet) => packet.pts)).toEqual([lastPts + FRAME]);
  });

  it("goes on at the stream's own pace: one picture's time after the last", () => {
    // 50 pictures a second.
    const pace = FRAME / 2;
    const { run, encoder, before } = playing(
      BASE,
      new Encoder({ video: 256, audio: 257, start: 900_000, frame: pace }),
    );
    const lastPts = encoder.pts - pace;
    run.moves.consider(NEXT);
    const next = moved({ frame: pace });
    run.feed(concatBytes(next.picture("idr"), next.picture("p")));
    expect(starts(run.got().slice(before), 256).map((packet) => packet.pts)).toEqual([
      lastPts + pace,
      lastPts + 2 * pace,
    ]);
  });

  it("starts the sound with the first picture, not with what the new encoder sent before it", () => {
    const { run, encoder, before } = playing();
    // The old stream's sound ends two frames before its pictures do.
    run.feed(concatBytes(encoder.picture("p", { silent: true }), encoder.picture("p", { silent: true })));
    const lastPts = encoder.pts - FRAME;
    run.moves.consider(NEXT);
    const next = moved();
    run.feed(concatBytes(next.picture("p"), next.picture("p"), next.picture("idr")));
    // The sound two frames before the picture would fit behind the old sound, but belongs to pictures left out.
    // The frame right before the picture may still sound into it.
    expect(starts(run.got().slice(before), 257).map((packet) => packet.pts)).toEqual([lastPts, lastPts + FRAME]);
    expect(starts(run.got().slice(before), 256).map((packet) => packet.pts)).toEqual([
      lastPts - FRAME,
      lastPts,
      lastPts + FRAME,
    ]);
  });

  it("keeps the times in order for pictures that are decoded before they are shown", () => {
    // The old encoder decodes each picture two frames before it shows it; the new one doesn't reorder.
    const { run, encoder, before } = playing(
      BASE,
      new Encoder({ video: 256, audio: 257, start: 900_000, delay: 2 * FRAME }),
    );
    const lastPts = encoder.pts - FRAME;
    run.moves.consider(NEXT);
    const next = moved();
    run.feed(concatBytes(next.picture("idr"), next.picture("p")));
    const pictures = starts(run.got().slice(before), 256);
    // Shown one frame after the last one shown: decoded later than the old stream's last one, too.
    expect(pictures.map((packet) => packet.pts)).toEqual([lastPts + FRAME, lastPts + 2 * FRAME]);
    expect(pictures.map((packet) => packet.dts)).toEqual([undefined, undefined]);

    // The other way round: the new encoder reorders, the old one didn't.
    const second = playing();
    const last = second.encoder.pts - FRAME;
    second.run.moves.consider(NEXT);
    const reordering = moved({ delay: 2 * FRAME });
    second.run.feed(concatBytes(reordering.picture("idr"), reordering.picture("p")));
    const shifted = starts(second.run.got().slice(second.before), 256);
    // Decoded one frame after the last one decoded, so shown two frames later than that.
    expect(shifted.map((packet) => packet.dts)).toEqual([last + FRAME, last + 2 * FRAME]);
    expect(shifted.map((packet) => packet.pts)).toEqual([last + 3 * FRAME, last + 4 * FRAME]);
  });

  it("goes on after the last picture shown, which is not the last one sent when pictures are reordered", () => {
    const { run, encoder, before } = playing();
    // In the order they are decoded: one that is shown three frames later, then the two shown before it.
    const base = encoder.pts;
    run.feed(
      concatBytes(
        encoder.at("p", base + 3 * FRAME, base),
        encoder.at("p", base + FRAME, base + FRAME),
        encoder.at("p", base + 2 * FRAME, base + 2 * FRAME),
      ),
    );
    run.moves.consider(NEXT);
    run.feed(moved().picture("idr"));
    // One frame after the picture shown last, not after the one sent last.
    expect(starts(run.got().slice(before), 256).at(-1)).toMatchObject({ pts: base + 4 * FRAME });
  });

  it("goes on from where the old stream was when its clock started over", () => {
    const { run, encoder, before } = playing(BASE, new Encoder({ video: 256, audio: 257, start: 9_000_000 }));
    // The old stream's times jump back by more than ten seconds, as when a broadcast loops a recording.
    const again = encoder.pts - 2_000_000;
    run.feed(encoder.at("idr", again));
    run.moves.consider(NEXT);
    run.feed(moved().picture("idr"));
    // The new stream follows the last picture, not the latest time the stream ever had, one frame
    // later: the jump says nothing about the stream's pace.
    expect(starts(run.got().slice(before), 256).at(-1)).toMatchObject({ pts: again + FRAME });
  });

  it("does not take a gap in the old stream's times for its pace", () => {
    const { run, encoder, before } = playing();
    // Two seconds without a picture, as when the broadcast's encoder hung for a moment.
    const late = encoder.pts + 180_000;
    run.feed(encoder.at("idr", late));
    run.moves.consider(NEXT);
    run.feed(moved().picture("idr"));
    expect(starts(run.got().slice(before), 256).at(-1)).toMatchObject({ pts: late + FRAME });
  });

  it("waits for a picture that says when it is shown", () => {
    const { run, encoder, before } = playing();
    const lastPts = encoder.pts - FRAME;
    run.moves.consider(NEXT);
    const next = moved();
    // A picture with the settings whose header carries no time: there is nothing to place it by.
    const timeless = next.at("idr", next.pts);
    timeless[4 + 7] = 0;
    timeless[4 + 8] = 0;
    run.feed(next.picture("p"));
    expect(run.kinds(timeless)).toEqual(["hold"]);
    expect(run.feed(next.picture("idr"))[0]).toHaveProperty("carried");
    expect(starts(run.got().slice(before), 256).map((packet) => packet.pts)).toEqual([lastPts + FRAME]);
  });

  it("goes on across the wrap of the stream's timestamps", () => {
    const { run, encoder, before } = playing(BASE, new Encoder({ video: 256, audio: 257, start: WRAP - 3 * FRAME }));
    // The old stream's last picture is the last one before its 33 bits start over.
    expect(encoder.pts).toBe(0);
    run.moves.consider(NEXT);
    const next = moved();
    run.feed(concatBytes(next.picture("idr"), next.picture("p")));
    const pictures = starts(run.got().slice(before), 256);
    expect(pictures.map((packet) => packet.pts)).toEqual([0, FRAME]);
    expect(pictures.map((packet) => packet.pcr)).toEqual([WRAP - 9000, FRAME + WRAP - 9000]);
  });

  it("carries HEVC video the same way", () => {
    const there = layoutOf(hevcStreams(211, 221));
    const { run, encoder, before } = playing(
      layoutOf(hevcStreams(256, 257)),
      new Encoder({ video: 256, audio: 257, start: 900_000, codec: "hevc" }),
    );
    const lastPts = encoder.pts - FRAME;
    expect(run.moves.consider(there)).toBe("looking");
    const next = moved({ codec: "hevc" });
    expect(run.kinds(next.picture("p"))).toEqual(["hold"]);
    expect(run.feed(next.picture("idr"))[0]).toHaveProperty("carried");
    expect(starts(run.got().slice(before), 256).map((packet) => packet.pts)).toEqual([lastPts + FRAME]);
  });

  it("gives up when the video's decoder settings differ, with what it held as it came", () => {
    const { run, before } = playing();
    run.moves.consider(NEXT);
    const next = moved({ sets: [SETS.smallSps, SETS.pps] });
    const first = next.picture("p");
    run.feed(first);
    const idr = next.picture("idr");
    const [verdict, ...rest] = run.feed(idr);
    expect(verdict).toMatchObject({ why: "the video's decoder settings differ" });
    // Everything since the change, untouched: a new run reads it from the start.
    const failed = isFailure(verdict!) ? concatBytes(...verdict.failed) : new Uint8Array(0);
    expect(failed).toEqual(concatBytes(first, idr.subarray(0, 188)));
    // The move is off: what follows is not held any more, and ffmpeg got nothing of it.
    expect(new Set(rest)).toEqual(new Set(["pass"]));
    expect(
      run
        .got()
        .slice(before)
        .every((packet) => packet.pid === 211 || packet.pid === 221),
    ).toBe(true);
    expect(run.moves.expire()).toBeUndefined();
  });

  it("gives up when an audio stream's settings differ", () => {
    const { run } = playing();
    run.moves.consider(NEXT);
    const next = moved({ sound: () => adtsFrame({ channels: 2 }) });
    const verdicts = run.feed(next.picture("p"));
    expect(verdicts.slice(0, -1)).toEqual(verdicts.slice(0, -1).map(() => "hold"));
    expect(verdicts.at(-1)).toMatchObject({ why: "an audio stream's settings differ" });
  });

  it("waits for the sound's settings too before the move is on", () => {
    const { run, encoder, before } = playing();
    const lastPts = encoder.pts - FRAME;
    run.moves.consider(NEXT);
    const next = moved();
    // The picture comes first: its sound has not shown what it is yet.
    expect(run.kinds(next.video("idr"))).toEqual(["hold"]);
    const verdicts = run.feed(next.picture("p"));
    expect(verdicts.at(-1)).toHaveProperty("carried");
    // Both pictures are passed on, the first one included.
    expect(starts(run.got().slice(before), 256).map((packet) => packet.pts)).toEqual([
      lastPts + FRAME,
      lastPts + FRAME,
    ]);
  });

  it("goes on from the first picture to start at, however many come before the sound shows its settings", () => {
    const { run, encoder, before } = playing();
    const lastPts = encoder.pts - FRAME;
    run.moves.consider(NEXT);
    const next = moved();
    const silent = concatBytes(
      next.picture("idr", { silent: true }),
      next.picture("p", { silent: true }),
      next.picture("idr", { silent: true }),
    );
    expect(run.kinds(silent)).toEqual(["hold"]);
    expect(run.feed(next.picture("p")).at(-1)).toHaveProperty("carried");
    // All four pictures, from the first one on.
    expect(starts(run.got().slice(before), 256).map((packet) => packet.pts)).toEqual(
      [1, 2, 3, 4].map((count) => lastPts + count * FRAME),
    );
  });

  it("gives up when the video shows other settings while the sound has not shown its own", () => {
    const { run } = playing();
    run.moves.consider(NEXT);
    const next = moved();
    expect(run.kinds(next.picture("idr", { silent: true }))).toEqual(["hold"]);
    // The picture to go on from is found; the next one to start at is of another size.
    const other = moved({ sets: [SETS.smallSps, SETS.pps] });
    const verdict = run.feed(other.picture("idr", { silent: true })).find((given) => isFailure(given));
    expect(verdict).toMatchObject({ why: "the video's decoder settings differ" });
  });

  it("gives up after 2.5 seconds without a picture to go on from", () => {
    const { run } = playing();
    run.moves.consider(NEXT);
    const next = moved();
    const held = next.picture("p");
    run.feed(held);
    run.clock.now = 2499;
    expect(run.moves.expire()).toBeUndefined();
    run.clock.now = 2500;
    const late = run.moves.expire();
    expect(late?.why).toBe("no picture to go on from in 2.5s");
    expect(concatBytes(...(late?.failed ?? []))).toEqual(held);
    // Only once.
    expect(run.moves.expire()).toBeUndefined();
  });

  it("counts the patience of a move that keeps coming back from its first look, until a new run begins", () => {
    const { run, encoder } = playing();
    expect(run.moves.consider(NEXT)).toBe("looking");
    run.feed(moved().picture("p"));
    // The tables go back after a second, with data held for the move: it comes back a second later.
    run.clock.now = 1000;
    expect(run.moves.giveUp()).not.toHaveLength(0);
    run.clock.now = 2000;
    expect(run.moves.consider(NEXT)).toBe("looking");
    run.feed(moved().picture("p"));
    run.clock.now = 2499;
    expect(run.moves.expire()).toBeUndefined();
    run.clock.now = 2500;
    expect(run.moves.expire()?.why).toBe("no picture to go on from in 2.5s");

    // A run that begins looks at the same move with its patience whole.
    run.moves.begin(BASE, [encoder.picture("idr")]);
    expect(run.moves.consider(NEXT)).toBe("looking");
    run.clock.now = 4999;
    expect(run.moves.expire()).toBeUndefined();
    run.clock.now = 5000;
    expect(run.moves.expire()).toBeDefined();
  });

  it("gives up after 4 MB without a picture to go on from", () => {
    const { run } = playing();
    run.moves.consider(NEXT);
    const next = moved();
    let failure: MoveFailure | undefined;
    let fed = 0;
    while (failure === undefined && fed < 5 * 1024 * 1024) {
      const picture = next.picture("p");
      fed += picture.length;
      failure = run.feed(picture).find((verdict) => isFailure(verdict));
    }
    expect(failure?.why).toBe("no picture to go on from in 4 MB");
    const held = failure?.failed.reduce((total, packet) => total + packet.length, 0) ?? 0;
    expect(held).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(held).toBeLessThan(4 * 1024 * 1024 + 188);
  });

  it("leaves the stream's new tables out, so that ffmpeg keeps the ones it has", () => {
    const { run, before } = playing();
    const tables = tablePackets(MOVED);
    // Before any move the tables pass as they come.
    expect(run.kinds(tablePackets(H264))).toEqual(["pass"]);
    run.moves.consider(NEXT);
    expect(run.kinds(tables)).toEqual(["drop"]);
    // Nor is a table ffmpeg's because it is on a PID the run's video had until now.
    expect(run.kinds(pmtPackets(MOVED, 1, 256), [0, 256])).toEqual(["drop"]);
    const next = moved();
    run.feed(next.picture("idr"));
    expect(run.kinds(tables)).toEqual(["drop"]);
    expect(
      run
        .got()
        .slice(before + 2)
        .every((packet) => packet.pid === 256 || packet.pid === 257),
    ).toBe(true);
  });

  it("reads on untouched when only the tables changed", () => {
    const { run, encoder } = playing();
    const length = run.got().length;
    // The same streams, their table on another PID.
    expect(run.moves.consider(layoutOf(H264, 0x10_01))).toBe("carried");
    const picture = encoder.picture("p");
    expect(run.kinds(picture, [0, 0x10_01])).toEqual(["pass"]);
    expect(run.got().slice(length)).toEqual(readPackets(picture));
    // The new tables are left out, and so is whatever comes on the PID the old ones were on.
    expect(run.kinds(tablePackets(H264, 0x10_01), [0, 0x10_01])).toEqual(["drop"]);
    expect(run.kinds(pmtPackets(H264, 0, PMT_PID), [0, 0x10_01])).toEqual(["drop"]);

    // A move after that goes on from what the run has read since.
    const lastPts = encoder.pts - FRAME;
    expect(run.moves.consider(layoutOf(MOVED, 0x10_01))).toBe("looking");
    const next = moved();
    run.feed(next.picture("idr"), [0, 0x10_01]);
    expect(starts(run.got(), 256).at(-1)?.pts).toBe(lastPts + FRAME);
    expect(countersContinue(run.got())).toBe(true);

    // And when the moved streams' table moves once more, they still go to the PIDs ffmpeg knows.
    expect(run.moves.consider(layoutOf(MOVED, 0x10_02))).toBe("carried");
    expect(run.kinds(next.picture("p"), [0, 0x10_02])).toEqual(["pass"]);
    expect(new Set(run.got().map((packet) => packet.pid))).toEqual(new Set([256, 257]));
    expect(starts(run.got(), 256).at(-1)?.pts).toBe(lastPts + 2 * FRAME);
    expect(countersContinue(run.got())).toBe(true);
  });

  it("says no to streams that are not the same ones, and to a run it can't check", () => {
    const { run } = playing();
    const hevc = layoutOf(hevcStreams(211, 221));
    expect(run.moves.consider(hevc)).toEqual({ no: "the streams are not the same ones on other PIDs" });
    // Only the sound moved: holding the video back for that is not worth it.
    const audioMoved = layoutOf([
      { pid: 256, type: 0x1b },
      { pid: 221, type: 0x0f },
    ]);
    expect(run.moves.consider(audioMoved)).toEqual({ no: "the video stayed on its PID" });
    // The refusals changed nothing: a move it can carry is still looked at.
    expect(run.moves.consider(NEXT)).toBe("looking");

    // A run on video whose settings are not read here: it can't move, but it reads on when only the tables change.
    const unchecked = { no: "the run reads streams whose decoder settings can't be compared" };
    const unknown = runOn(layoutOf(mpeg2Streams(256, 257)));
    const unknownMoved = layoutOf(mpeg2Streams(211, 221));
    const unknownTables = layoutOf(mpeg2Streams(256, 257), 0x10_01);
    expect(unknown.moves.consider(unknownMoved)).toEqual(unchecked);
    expect(unknown.moves.consider(unknownTables)).toBe("carried");
    // Two video streams: which one leads can't be told.
    const double = runOn(layoutOf(twoVideos(256)));
    const doubleMoved = layoutOf(twoVideos(211));
    expect(double.moves.consider(doubleMoved)).toEqual(unchecked);
    // Video that could be checked beside sound that can't: the sound's decoder would go on unchecked.
    const unheard = runOn(layoutOf(latmStreams(256, 257)));
    const unheardMoved = layoutOf(latmStreams(211, 221));
    expect(unheard.moves.consider(unheardMoved)).toEqual(unchecked);
  });

  it("says no until the run has read its streams' settings", () => {
    const encoder = original();
    const run = runOn(BASE);
    const no = { no: "the run has not read its streams' decoder settings yet" };
    expect(run.moves.consider(NEXT)).toEqual(no);
    // A picture without the settings, then the settings without any sound yet.
    run.feed(encoder.picture("p"));
    expect(run.moves.consider(NEXT)).toEqual(no);
    const silent = runOn(BASE);
    silent.feed(original().video("idr"));
    expect(silent.moves.consider(NEXT)).toEqual(no);
    run.feed(encoder.picture("idr"));
    expect(run.moves.consider(NEXT)).toBe("looking");
  });

  it("carries a run over a second move, and back to the PIDs it started on", () => {
    const { run, encoder, before } = playing();
    const lastPts = encoder.pts - FRAME;
    run.moves.consider(NEXT);
    const second = moved();
    run.feed(concatBytes(second.picture("idr"), second.picture("p")));

    expect(run.moves.consider(layoutOf(MOVED_AGAIN))).toBe("looking");
    const third = new Encoder({ video: 311, audio: 321, start: 77_000_000 });
    run.feed(third.picture("p"));
    // What the second encoder still sends is passed on while the third shows no picture to start at.
    expect(run.kinds(second.picture("p"))).toEqual(["pass"]);
    run.feed(concatBytes(third.picture("idr"), third.picture("p")));
    // And left out once the third one is on, like what comes on the PIDs ffmpeg knows.
    expect(run.kinds(second.picture("p"))).toEqual(["drop"]);
    expect(run.kinds(encoder.picture("p"))).toEqual(["drop"]);

    // Back to where it started: the packets need no other PIDs, but the times and counters still go on.
    expect(run.moves.consider(BASE)).toBe("looking");
    const fourth = new Encoder({ video: 256, audio: 257, start: 300_000 });
    run.feed(concatBytes(fourth.picture("idr"), fourth.picture("p")));
    expect(run.kinds(third.picture("p"))).toEqual(["drop"]);

    const after = run.got().slice(before);
    expect(new Set(after.map((packet) => packet.pid))).toEqual(new Set([256, 257]));
    expect(starts(after, 256).map((packet) => packet.pts)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((frames) => lastPts + frames * FRAME),
    );
    expect(countersContinue(run.got())).toBe(true);
  });

  it("carries a clock reference that has a PID of its own", () => {
    const { run, encoder, before } = playing(BASE_CLOCKED);
    const lastPts = encoder.pts - FRAME;
    const oldClock = withCounter(encoder.writer.clock(300, lastPts), 9);
    expect(run.feed(oldClock)).toEqual(["pass"]);
    expect(run.moves.consider(NEXT_CLOCKED)).toBe("looking");
    const next = moved();
    // The new clock's packets are held like the streams', and passed on once the video is.
    const clock = (counter: number): Uint8Array => withCounter(next.writer.clock(400, next.pts - 100), counter);
    expect(run.feed(clock(3))).toEqual(["hold"]);
    run.feed(next.picture("idr"));
    // The new encoder marks a break on its packets, as it may: to ffmpeg the first one goes on.
    const after = concatBytes(withBreak(clock(3)), withBreak(clock(3)), clock(4));
    expect(run.feed(after)).toEqual(["pass", "pass", "pass"]);
    const clocks = run
      .got()
      .slice(before)
      .filter((packet) => packet.pid === 300);
    // Before the first picture it belongs to the part left out; after it, it is on the old clock's time.
    expect(clocks.map((packet) => packet.pcr)).toEqual([lastPts, ...[1, 2, 3].map(() => lastPts + 2 * FRAME - 100)]);
    // A packet without a payload repeats the counter of the one before it: the first one passed on
    // repeats the last one ffmpeg got, and from there the stream's own steps show.
    expect(clocks.map((packet) => packet.counter)).toEqual([9, 9, 9, 10]);
    // A break the stream marks later is its own.
    expect(clocks.map((packet) => packet.discontinuity)).toEqual([false, false, true, false]);
    expect(run.got().some((packet) => packet.pid === 400)).toBe(false);
  });

  it("keeps the stream's own steps in the counters, so that ffmpeg sees where a packet was lost", () => {
    const { run, before } = playing();
    run.moves.consider(NEXT);
    const next = moved();
    // A clock reference alone between two pictures, as muxers send it on the video's PID.
    const sent = concatBytes(
      next.picture("idr"),
      next.picture("p"),
      next.writer.clock(211, next.pts),
      next.picture("p"),
      next.picture("p"),
    );
    // The second packet of the picture before the last never arrives.
    const all = readPackets(sent);
    const tails = all
      .keys()
      .filter((index) => all[index]?.pid === 211 && all[index].payload.length > 0 && !all[index].start);
    const gone = tails.toArray().at(-2) ?? -1;
    const last = starts(run.got(), 256).at(-1);
    run.feed(concatBytes(sent.subarray(0, gone * 188), sent.subarray((gone + 1) * 188)));
    const got = run.got().slice(before);
    const video = got.filter((packet) => packet.pid === 256);
    const source = all.filter((packet, index) => packet.pid === 211 && index !== gone);
    expect(video).toHaveLength(source.length);
    // The first packet goes on from the last one ffmpeg got on the PID...
    const shift = ((last?.counter ?? 0) + 2 - (source[0]?.counter ?? 0)) & 0x0f;
    // ...(the old picture had two packets)...
    expect(video[0]?.counter).toBe(((last?.counter ?? 0) + 2) & 0x0f);
    // ...and every one after it is as far from the stream's own as the first: the packet without
    // a payload repeats the counter before it, and the lost one leaves its gap.
    expect(video.map((packet) => packet.counter)).toEqual(source.map((packet) => (packet.counter + shift) & 0x0f));
    expect(countersContinue(source)).toBe(false);
    expect(countersContinue(video)).toBe(false);
  });

  it("lets in no stream the run doesn't know, while it looks at a move and once the move is on", () => {
    const { run, encoder } = playing(TEXT_BASE);
    const writer = new TsWriter();
    // The text where the run found it, where it is after the move, and a stream the tables don't list.
    const known = textUnit(writer, 258, 5_000_000);
    const unknown = textUnit(writer, 222, 5_000_000);
    const unlisted = textUnit(writer, 600, 5_000_000);
    // The stream as the run found it is all ffmpeg's.
    expect(run.kinds(concatBytes(known, unlisted))).toEqual(["pass"]);
    expect(run.moves.consider(TEXT_NEXT)).toBe("looking");
    // A stream on a PID ffmpeg has not seen would make it stop and study it, with no frame for
    // players meanwhile.
    expect(run.kinds(concatBytes(unknown, unlisted))).toEqual(["drop"]);
    // What the old layout still sends on the PIDs the run knows goes on.
    const still = concatBytes(known, encoder.picture("p"));
    expect(run.kinds(still)).toEqual(["pass"]);
    const next = moved();
    expect(run.feed(next.picture("idr")).at(-1)).toHaveProperty("carried");
    const late = concatBytes(unknown, unlisted, known, encoder.picture("p"));
    expect(run.kinds(late)).toEqual(["drop"]);
    expect(run.kinds(next.picture("p"))).toEqual(["pass"]);
  });

  it("leaves out a PID of the run's that the new layout has for another stream, while it looks", () => {
    const { run, encoder } = playing();
    const writer = new TsWriter();
    // The sound's old PID is the text's now.
    const reused = layoutOf(withText(211, 221, 257));
    expect(run.moves.consider(reused)).toBe("looking");
    expect(run.kinds(textUnit(writer, 257, 5_000_000))).toEqual(["drop"]);
    expect(run.kinds(encoder.video("p"))).toEqual(["pass"]);
    // The move is off (the tables went back): the run's PIDs are its own again, and so is the rest.
    expect(run.moves.giveUp()).toEqual([]);
    const rest = concatBytes(encoder.picture("p"), textUnit(writer, 600, 5_000_000));
    expect(run.kinds(rest)).toEqual(["pass"]);
  });

  it("starts a stream that rides with the clock reference at the start of one of its units", () => {
    // The clock reference is on the text's PID, before the move and after it.
    const { run, before } = playing(withClockOn(TEXT_BASE, 258));
    const writer = new TsWriter();
    expect(run.kinds(textUnit(writer, 258, 900_000))).toEqual(["pass"]);
    expect(run.moves.consider(withClockOn(TEXT_NEXT, 222))).toBe("looking");
    const next = moved();
    // A unit of three packets that belongs before the picture the run goes on from ends after it.
    const long = textUnit(writer, 222, next.pts - 9000, 400);
    expect(run.kinds(long.subarray(0, 188))).toEqual(["hold"]);
    expect(run.feed(next.picture("idr")).at(-1)).toHaveProperty("carried");
    expect(run.kinds(long.subarray(188))).toEqual(["drop"]);
    expect(run.kinds(textUnit(writer, 222, next.pts))).toEqual(["pass"]);
    const texts = run
      .got()
      .slice(before)
      .filter((packet) => packet.pid === 258);
    expect(texts.map((packet) => packet.start)).toEqual([true, true]);
  });

  it("starts the sound with a unit that tells its time, not with a packet that has none", () => {
    const { run, encoder, before } = playing();
    // The old sound ran four frames ahead of the old pictures.
    const ahead = [0, 1, 2, 3].map((count) =>
      encoder.writer.pes(257, "audio", adtsFrame(), { pts: encoder.pts + count * 1920 }),
    );
    run.feed(concatBytes(...ahead));
    const lastSound = encoder.pts + 3 * 1920;
    run.moves.consider(NEXT);
    const next = moved();
    // A clock reference alone on the sound's new PID comes right behind the first picture.
    run.feed(concatBytes(next.picture("idr"), next.writer.clock(221, next.pts), next.picture("p"), next.picture("p")));
    const sound = starts(run.got().slice(before), 257).map((packet) => packet.pts ?? 0);
    // Nothing of the new sound that belongs before the end of the old one was passed on.
    expect(sound.slice(4).every((pts) => pts > lastSound)).toBe(true);
    expect(sound.every((pts, index) => index === 0 || pts > (sound[index - 1] ?? 0))).toBe(true);
  });

  it("starts fresh with every run", () => {
    const { run } = playing();
    run.moves.consider(NEXT);
    const next = moved();
    run.feed(next.picture("idr"));
    // A new run reads the moved layout as it comes: nothing is rewritten for it.
    run.moves.begin(NEXT);
    const length = run.got().length;
    const picture = next.picture("p");
    expect(run.kinds(picture)).toEqual(["pass"]);
    expect(run.got().slice(length)).toEqual(readPackets(picture));
    expect(run.kinds(tablePackets(MOVED))).toEqual(["pass"]);
  });

  it("knows a run's streams from what it was given before it began", () => {
    const { moves, feed, kinds, got } = runOn(BASE);
    const encoder = original();
    // Two pictures the run got first of all, which the reader kept back for it; a cut packet after them counts for nothing.
    const cut = new Encoder({ video: 256, audio: 257, start: 70_000_000 }).picture("p").subarray(0, 100);
    const given = [encoder.picture("idr"), concatBytes(encoder.picture("p"), cut)];
    moves.begin(BASE, given);
    expect(moves.consider(NEXT)).toBe("looking");
    const there = moved();
    expect(kinds(there.picture("idr"))).toEqual(["carried", "hold"]);
    feed(there.picture("p"));
    // Times go on from the last picture it was given.
    expect(starts(got(), 256).map((packet) => packet.pts)).toEqual([900_000 + 2 * FRAME, 900_000 + 3 * FRAME]);
  });

  it("reads on when a stream it doesn't read comes, and leaves that one out", () => {
    const { run, encoder } = playing();
    const lastPts = encoder.pts - FRAME;
    const extraStream = { pid: 300, type: 0x0f };
    const writer = new TsWriter();
    const extra = (): Uint8Array => writer.pes(300, "audio", adtsFrame(), { pts: 123_000 });
    // Until the tables name it, a new PID is passed on like anything else the stream carries.
    expect(run.kinds(extra())).toEqual(["pass"]);
    expect(run.moves.consider(layoutOf([...H264, extraStream]))).toBe("carried");
    // From then on it is left out, like the new tables; the run's own streams pass as they are.
    const tables = concatBytes(tablePackets([...H264, extraStream], PMT_PID, 1), extra());
    expect(run.kinds(tables)).toEqual(["drop"]);
    const length = run.got().length;
    expect(run.kinds(encoder.picture("p"))).toEqual(["pass"]);
    const after = run.got().slice(length);
    expect(new Set(after.map((packet) => packet.pid))).toEqual(new Set([256, 257]));
    expect(starts(after, 256).map((packet) => packet.pts)).toEqual([lastPts + FRAME]);

    // It goes again: nothing changes for the run. And a move of the run's own streams is still carried.
    expect(run.moves.consider(BASE)).toBe("carried");
    expect(run.moves.consider(NEXT)).toBe("looking");
    const there = moved();
    run.feed(concatBytes(there.picture("idr"), there.picture("p")));
    expect(starts(run.got(), 256).map((packet) => packet.pts)).toEqual(
      [-2, -1, 0, 1, 2, 3].map((step) => lastPts + step * FRAME),
    );
    // The extra stream comes back, next to the streams where they are now.
    expect(run.moves.consider(layoutOf([...MOVED, extraStream]))).toBe("carried");
    expect(run.kinds(extra())).toEqual(["drop"]);
    run.feed(there.picture("p"));
    expect(starts(run.got(), 256).at(-1)?.pts).toBe(lastPts + 4 * FRAME);
    expect(new Set(run.got().map((packet) => packet.pid))).toEqual(new Set([256, 257, 300]));
  });

  it("reads on over a change that had to wait when its streams are where they were, and over no other", () => {
    const { run } = playing();
    // While it waited, packets came on the run's PIDs and on the new ones.
    const heard = new Set([0, PMT_PID, 256, 257, 211, 221]);
    expect(run.moves.consider(layoutOf(H264, 0x10_01), heard)).toBe("carried");
    expect(run.moves.consider(NEXT, heard)).toEqual({
      no: "the change had to wait its turn, and the run got the stream as it came meanwhile",
    });
    // Video on the new PIDs is enough, and so is sound.
    expect(run.moves.consider(NEXT, new Set([256, 257, 211]))).toEqual({
      no: "the change had to wait its turn, and the run got the stream as it came meanwhile",
    });
    expect(run.moves.consider(NEXT, new Set([256, 257, 221]))).toEqual({
      no: "the change had to wait its turn, and the run got the stream as it came meanwhile",
    });
    expect(run.moves.consider(NEXT)).toBe("looking");
  });

  it("looks at a move that had to wait when nothing came on the PIDs it moves the streams to meanwhile", () => {
    const { run } = playing();
    expect(run.moves.consider(NEXT, new Set([0, PMT_PID, 256, 257]))).toBe("looking");
  });

  it("looks at a move of the video alone that had to wait, while the sound stays on its PID and the video didn't come", () => {
    const { run } = playing();
    const partly = layoutOf([
      { pid: 211, type: 0x1b },
      { pid: 257, type: 0x0f },
    ]);
    expect(run.moves.consider(partly, new Set([256, 257]))).toBe("looking");
    run.moves.giveUp();
    expect(run.moves.consider(partly, new Set([256, 257, 211]))).toEqual({
      no: "the change had to wait its turn, and the run got the stream as it came meanwhile",
    });
  });

  it("starts a new run for a move that had to wait when packets came on its clock's own PID meanwhile", () => {
    const { run } = playing(BASE_CLOCKED);
    expect(run.moves.consider(NEXT_CLOCKED, new Set([256, 257, 300, 400]))).toEqual({
      no: "the change had to wait its turn, and the run got the stream as it came meanwhile",
    });
    expect(run.moves.consider(NEXT_CLOCKED, new Set([256, 257, 300]))).toBe("looking");
  });

  it("starts a new run for a change that had to wait and is no move, whatever came meanwhile", () => {
    const { run } = playing();
    const hevc = layoutOf([
      { pid: 256, type: 0x24 },
      { pid: 257, type: 0x0f },
    ]);
    expect(run.moves.consider(hevc, new Set([0]))).toEqual({
      no: "the change had to wait its turn, and the run got the stream as it came meanwhile",
    });
    // A move of the sound alone gets one too, as when it came in its turn.
    const sound = layoutOf([
      { pid: 256, type: 0x1b },
      { pid: 258, type: 0x0f },
    ]);
    expect(run.moves.consider(sound, new Set([256]))).toEqual({ no: "the video stayed on its PID" });
  });
});
