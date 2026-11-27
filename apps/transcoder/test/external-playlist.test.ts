import { describe, expect, it } from "vitest";
import { ExternalPlaylist, SLATE_AFTER_MS, SLATE_MARGIN_MS, type Slate } from "../src/external-playlist.ts";

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
    // A discontinuity that left the list counts in the sequence of discontinuities.
    expect(at(14)).toBe("s1 s2 | s0 s1 s2 | s0");
    expect(sequences(text(14))).toEqual([4, 1]);
    // Segments that came due between two requests are all there, in order.
    expect(at(36)).toBe("s0 s1 s2 | s0 s1 s2");
    expect(sequences(text(36))).toEqual([15, 5]);
    expect(at(38)).toBe("s1 s2 | s0 s1 s2 | s0");
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

  it("takes the slate again when no segment of the stream came for five seconds, with three segments at once", () => {
    const { at, segment, slates } = make();
    expect(at(0)).toBe("s0 s1 s2");
    segment(1, 1, 0);
    segment(3, 1, 1);
    expect(SLATE_AFTER_MS).toBe(5000);
    expect(at(7.9)).toBe("s0 s1 s2 | g1:0 g1:1");
    expect(slates()).toBe(0);
    // A player played what it had of the stream while the slate waited: it gets three segments
    // again, from its first one, and one more as each comes due.
    expect(at(8)).toBe("s2 | g1:0 g1:1 | s0 s1 s2");
    expect(slates()).toBe(1);
    expect(at(9.9)).toBe("s2 | g1:0 g1:1 | s0 s1 s2");
    expect(at(10)).toBe("g1:0 g1:1 | s0 s1 s2 | s0");
    // The stream is back, in the same ffmpeg run: its segments are behind a discontinuity all the same.
    segment(11, 1, 2);
    expect(at(11)).toBe("g1:1 | s0 s1 s2 | s0 | g1:2");
    expect(slates()).toBe(1);
    // Five seconds count from its last segment, each time, and each time counts once.
    segment(13, 1, 3);
    expect(at(17.9)).toBe("s0 s1 s2 | s0 | g1:2 g1:3");
    expect(at(18)).toBe("s0 | g1:2 g1:3 | s0 s1 s2");
    expect(slates()).toBe(2);
  });

  it("starts the slate with the request that finds it due, however long ago that was", () => {
    const { at, segment, slates } = make();
    segment(1, 1, 0);
    segment(3, 1, 1);
    // Nobody asked for half a minute after the stream stopped: the slate is not half a minute long.
    expect(at(33)).toBe("g1:0 g1:1 | s0 s1 s2");
    expect(at(35)).toBe("g1:0 g1:1 | s0 s1 s2 | s0");
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
    expect(at(15)).toBe("g1:0 g1:1 | s0 s1 s2");
    expect(slates()).toBe(1);
    // A short segment after long ones: the next may be long again.
    segment(16, 1, 2, 2);
    expect(at(24.9)).toBe("g1:0 g1:1 | s0 s1 s2 | g1:2");
    expect(at(25)).toBe("s1 s2 | g1:2 | s0 s1 s2");
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
    expect(at(111)).toMatch(/g1:8 \| s0 s1 s2$/);
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
    expect(at(76)).toMatch(/g1:3 \| s0 s1 s2$/);
    expect(slates()).toBe(2);
    // With a long segment listed again, the slate waits as it did before the outage.
    segment(82, 1, 4, 12);
    segment(94, 1, 5, 12);
    for (let second = 94; second <= 108; second += 2) {
      expect(at(second), String(second)).toMatch(/g1:5$/);
    }
    expect(at(109)).toMatch(/g1:5 \| s0 s1 s2$/);
    expect(slates()).toBe(3);
  });

  it("doesn't wait longer after a segment whose time spans an outage", () => {
    const { at, segment } = make();
    segment(0, 1, 0);
    // The first one after 40 seconds without data says it lasts that long.
    segment(42, 1, 1, 41.5);
    expect(at(46.9).endsWith("g1:1")).toBe(true);
    expect(at(47).endsWith("g1:1 | s0 s1 s2")).toBe(true);
    // Nor after a second one soon after.
    segment(48, 1, 2);
    segment(75, 1, 3, 26);
    expect(at(79.9).endsWith("g1:3")).toBe(true);
    expect(at(80).endsWith("g1:3 | s0 s1 s2")).toBe(true);
  });

  it("tells a segment that spans an outage from a stream's usual long ones", () => {
    const long = make();
    long.segment(0, 1, 0, 12);
    long.segment(12, 1, 1, 12);
    long.segment(24, 1, 2, 12);
    // After 40 seconds without data: more than twice what its segments usually last.
    long.segment(76, 1, 3, 52);
    expect(long.at(90.9)).toBe("g1:3");
    expect(long.at(91)).toBe("g1:3 | s0 s1 s2");
    // A stream's first segment says what is usual, unless no stream that plays has one that long:
    // a full output that writes none for 30 seconds is started again.
    const first = make();
    first.segment(0, 1, 0, 41.5);
    expect(first.at(4.9)).toBe("g1:0");
    expect(first.at(5)).toBe("g1:0 | s0 s1 s2");
    // Where a full output may take a minute, a broadcast with key frames 40 seconds apart plays.
    const patient = make(() => SLATE, STALE_MS, 60_000);
    patient.segment(0, 1, 0, 40);
    patient.segment(40, 1, 1, 40);
    expect(patient.at(59)).toBe("g1:0 g1:1");
    expect(patient.at(82.9)).toBe("g1:1");
    expect(patient.at(83)).toBe("g1:1 | s0 s1 s2");
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
    expect(at(43)).toBe("g1:2 | g2:0 g2:1 | s0 s1 s2");
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
    expect(at(650)).toBe("s2 | s0 s1 s2 | s0 s1");
    expect(sequences(text(650))).toEqual([25, 8]);
    // After more than a minute it goes on from now, with three segments again.
    expect(at(800)).toBe("s2 | s0 s1");
    expect(sequences(text(800))).toEqual([31, 10]);
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
