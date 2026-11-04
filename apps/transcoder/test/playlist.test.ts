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

  it("ignores an older generation after a newer one started", () => {
    const playlist = new VirtualPlaylist(10);
    playlist.append(2, segments(0, 0), "2/");
    playlist.append(1, segments(5, 6), "1/");
    expect(playlist.length).toBe(1);
  });
});
