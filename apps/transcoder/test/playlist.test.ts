import { describe, expect, it } from "vitest";
import { parseMediaPlaylist, VirtualPlaylist, type PlaylistSegment } from "../src/playlist.ts";

const FFMPEG_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXTINF:2.000000,
seg_000007.ts
#EXTINF:1.960000,
seg_000008.ts
`;

function segments(from: number, to: number): PlaylistSegment[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => ({
    duration: 2,
    uri: `seg_${String(from + offset).padStart(6, "0")}.ts`,
  }));
}

describe("parseMediaPlaylist", () => {
  it("reads the sequence and segments ffmpeg writes", () => {
    expect(parseMediaPlaylist(FFMPEG_PLAYLIST)).toEqual({
      mediaSequence: 7,
      segments: [
        { duration: 2, uri: "seg_000007.ts" },
        { duration: 1.96, uri: "seg_000008.ts" },
      ],
    });
  });
});

describe("VirtualPlaylist", () => {
  it("renders nothing until a segment exists", () => {
    expect(new VirtualPlaylist(5).render()).toBeUndefined();
  });

  it("appends only new segments and slides the window", () => {
    const playlist = new VirtualPlaylist(3);
    playlist.append(1, segments(0, 1), "1/");
    playlist.append(1, segments(0, 3), "1/");
    expect(playlist.length).toBe(3);
    const text = playlist.render()!;
    expect(text).toContain("#EXT-X-MEDIA-SEQUENCE:1\n");
    expect(text).toContain("1/seg_000003.ts");
    expect(text).not.toContain("1/seg_000000.ts");
  });

  it("tells of each segment it takes, once, as it lists it", () => {
    const taken: unknown[][] = [];
    const playlist = new VirtualPlaylist(2, (...segment) => {
      taken.push(segment);
    });
    playlist.append(1, segments(0, 1), "../g1/full/", 1000);
    // Segments it has are not taken again, and the ones that left its window were still taken.
    playlist.append(1, segments(0, 3), "../g1/full/", 3000);
    playlist.append(2, segments(0, 0), "../g2/full/", 4000);
    // A run it went on from adds nothing more.
    playlist.append(1, segments(4, 4), "../g1/full/", 5000);
    expect(taken).toEqual([
      [1, { uri: "../g1/full/seg_000000.ts", duration: 2 }, 1000],
      [1, { uri: "../g1/full/seg_000001.ts", duration: 2 }, 1000],
      [1, { uri: "../g1/full/seg_000002.ts", duration: 2 }, 3000],
      [1, { uri: "../g1/full/seg_000003.ts", duration: 2 }, 3000],
      [2, { uri: "../g2/full/seg_000000.ts", duration: 2 }, 4000],
    ]);
  });

  it("stitches generations with discontinuities and keeps counting", () => {
    const playlist = new VirtualPlaylist(4);
    playlist.append(1, segments(0, 2), "1/");
    playlist.append(2, segments(0, 1), "2/");
    let text = playlist.render()!;
    expect(text.match(/#EXT-X-DISCONTINUITY\n/g)).toHaveLength(1);
    expect(text).toContain("#EXT-X-MEDIA-SEQUENCE:1\n");
    expect(text.indexOf("#EXT-X-DISCONTINUITY\n")).toBeLessThan(text.indexOf("2/seg_000000.ts"));

    // Once the boundary scrolls out of the window it is counted in the discontinuity sequence.
    playlist.append(2, segments(2, 5), "2/");
    text = playlist.render()!;
    expect(text).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:1\n");
    expect(text).not.toContain("#EXT-X-DISCONTINUITY\n");
    expect(text).toContain("#EXT-X-MEDIA-SEQUENCE:5\n");
  });

  it("never goes back to a generation it went on from", () => {
    const playlist = new VirtualPlaylist(10);
    playlist.append(1, segments(0, 0), "1/");
    playlist.append(2, segments(0, 0), "2/");
    expect(playlist.append(1, segments(0, 2), "1/")).toBe(0);
    expect(playlist.length).toBe(2);
    // Nor once the generation after it was left too.
    playlist.append(3, segments(0, 0), "3/");
    expect(playlist.append(1, segments(0, 2), "1/")).toBe(0);
    expect(playlist.append(2, segments(0, 2), "2/")).toBe(0);
    expect(playlist.append(3, segments(0, 1), "3/")).toBe(1);
    expect(playlist.length).toBe(4);
  });

  it("takes the generations in the order they come, whatever their numbers", () => {
    // A source that waited to take over (2) comes after a run the playing source started meanwhile (3).
    const playlist = new VirtualPlaylist(10);
    playlist.append(1, segments(0, 1), "1/");
    expect(playlist.append(3, segments(0, 0), "3/")).toBe(1);
    expect(playlist.append(2, segments(4, 5), "2/")).toBe(2);
    expect(playlist.append(2, segments(4, 6), "2/")).toBe(1);
    expect(playlist.append(3, segments(0, 1), "3/")).toBe(0);
    const uris = playlist
      .render()
      ?.split("\n")
      .filter((line) => line.endsWith(".ts") || line === "#EXT-X-DISCONTINUITY");
    expect(uris).toEqual([
      "1/seg_000000.ts",
      "1/seg_000001.ts",
      "#EXT-X-DISCONTINUITY",
      "3/seg_000000.ts",
      "#EXT-X-DISCONTINUITY",
      "2/seg_000004.ts",
      "2/seg_000005.ts",
      "2/seg_000006.ts",
    ]);
  });

  it("remembers the generations it went on from for longer than any could still write", () => {
    const playlist = new VirtualPlaylist(4);
    for (let generation = 1; generation <= 66; generation += 1) {
      playlist.append(generation, segments(0, 0), `${String(generation)}/`);
    }
    // The last 64 it left are remembered; the one before them is long gone.
    expect(playlist.append(2, segments(1, 1), "2/")).toBe(0);
    expect(playlist.append(65, segments(1, 1), "65/")).toBe(0);
    expect(playlist.append(1, segments(1, 1), "1/")).toBe(1);
  });

  it("drops segments older than a time, and keeps both sequences counting across the gap", () => {
    const playlist = new VirtualPlaylist(6);
    playlist.append(1, segments(0, 2), "1/", 1000);
    playlist.append(1, segments(3, 3), "1/", 5000);
    playlist.expire(2000);
    expect(playlist.render()).toContain("#EXT-X-MEDIA-SEQUENCE:3\n");
    playlist.expire(6000);
    expect(playlist.render()).toBeUndefined();

    // The next source comes after the gap: its first segment carries the tag at the head.
    playlist.append(2, segments(0, 1), "2/", 7000);
    const first = playlist.render()!;
    expect(first).toContain("#EXT-X-MEDIA-SEQUENCE:4\n");
    expect(first).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:0\n");
    expect(first).toContain("#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\n2/seg_000000.ts");
    // Once that segment leaves, the tag left with it: the discontinuity sequence counts it.
    playlist.append(2, segments(2, 6), "2/", 8000);
    const later = playlist.render()!;
    expect(later).toContain("#EXT-X-MEDIA-SEQUENCE:5\n");
    expect(later).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:1\n");
    expect(later).not.toContain("#EXT-X-DISCONTINUITY\n");
  });
});
