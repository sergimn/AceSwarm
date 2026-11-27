import { describe, expect, test } from "vitest";
import { describeDevice, describePlayer, Viewers } from "../src/viewers.ts";

function viewers(maxViewers?: number) {
  const clock = { now: 1_000_000 };
  let made = 0;
  const tracker = new Viewers({
    pingMs: 60_000,
    now: () => clock.now,
    // The ids of players outside the page, in the order they are made up.
    newId: () => {
      made += 1;
      return `external${String(made)}`;
    },
    ...(maxViewers !== undefined && { maxViewers }),
  });
  return { tracker, clock };
}

const VLC = "VLC/3.0.20 LibVLC/3.0.20";
const FFMPEG = "Lavf/61.7.100";

describe("viewers", () => {
  test("counts the players showing a stream, until they close it", () => {
    const { tracker } = viewers();
    tracker.report("aaaaaaaa", "s1", "Chrome on TV");
    tracker.report("bbbbbbbb", "s1", "Firefox on Linux");
    tracker.report("cccccccc", "s2", "Chrome on TV");
    expect(tracker.count("s1")).toBe(2);
    expect(tracker.count("s2")).toBe(1);
    expect(tracker.count("s3")).toBe(0);

    tracker.report("bbbbbbbb", null, "Firefox on Linux");
    expect(tracker.count("s1")).toBe(1);
    // Switching streams moves the viewer.
    tracker.report("aaaaaaaa", "s2", "Chrome on TV");
    expect(tracker.count("s1")).toBe(0);
    expect(tracker.count("s2")).toBe(2);
  });

  test("forgets a viewer that missed about two reports", () => {
    const { tracker, clock } = viewers();
    tracker.report("aaaaaaaa", "s1", "Chrome");
    clock.now += 120_000;
    expect(tracker.count("s1")).toBe(1);
    // A report keeps the time it started watching.
    tracker.report("aaaaaaaa", "s1", "Chrome");
    clock.now += 149_000;
    expect(tracker.list()).toEqual([
      { viewer: "aaaaaaaa", stream: "s1", device: "Chrome", since: new Date(1_000_000).toISOString() },
    ]);
    clock.now += 2000;
    expect(tracker.count("s1")).toBe(0);
    expect(tracker.list()).toEqual([]);
  });

  test("drops the viewers of a removed stream", () => {
    const { tracker } = viewers();
    tracker.report("aaaaaaaa", "s1", "Chrome");
    tracker.report("bbbbbbbb", "s2", "Chrome");
    tracker.forgetStream("s1");
    expect(tracker.list().map(({ viewer }) => viewer)).toEqual(["bbbbbbbb"]);
  });

  test("keeps at most a fixed number, dropping the one heard from longest ago", () => {
    const { tracker } = viewers(2);
    tracker.report("aaaaaaaa", "s1", "Chrome");
    tracker.report("bbbbbbbb", "s1", "Chrome");
    tracker.report("aaaaaaaa", "s1", "Chrome");
    tracker.report("cccccccc", "s1", "Chrome");
    expect(tracker.list().map(({ viewer }) => viewer)).toEqual(["aaaaaaaa", "cccccccc"]);
  });
});

describe("players outside the page", () => {
  test("count while they ask for the stream's playlist, under a random id that says nothing of them", () => {
    const { tracker, clock } = viewers();
    tracker.poll("s1", "192.0.2.7", VLC);
    clock.now += 2000;
    tracker.poll("s1", "192.0.2.7", VLC);
    expect(tracker.count("s1")).toBe(1);
    // The same player all along: it keeps its id and the time it started.
    expect(tracker.list()).toEqual([
      { viewer: "external1", stream: "s1", device: "VLC", since: new Date(1_000_000).toISOString() },
    ]);
    expect(JSON.stringify(tracker.list())).not.toContain("192.0.2.7");
  });

  test("are told apart by address, by User-Agent and by stream", () => {
    const { tracker } = viewers();
    tracker.poll("s1", "192.0.2.7", VLC);
    tracker.poll("s1", "192.0.2.8", VLC);
    tracker.poll("s1", "192.0.2.7", FFMPEG);
    // One address can play two streams at once, in two players of the same kind.
    tracker.poll("s2", "192.0.2.7", VLC);
    expect(tracker.count("s1")).toBe(3);
    expect(tracker.count("s2")).toBe(1);
    expect(tracker.list().map(({ viewer, device }) => `${viewer} ${device}`)).toEqual([
      "external1 VLC",
      "external2 VLC",
      "external3 ffmpeg",
      "external4 VLC",
    ]);
    // A player that says nothing of itself counts too.
    tracker.poll("s2", "192.0.2.9");
    expect(tracker.list().at(-1)).toMatchObject({ viewer: "external5", device: "External player" });
  });

  test("stop counting half a minute after their last request, and come back as new viewers", () => {
    const { tracker, clock } = viewers();
    tracker.poll("s1", "192.0.2.7", VLC);
    // A page next to it counts for as long as pages do.
    tracker.report("aaaaaaaa", "s1", "Chrome on TV");
    clock.now += 30_000;
    expect(tracker.count("s1")).toBe(2);
    clock.now += 1;
    expect(tracker.list().map(({ viewer }) => viewer)).toEqual(["aaaaaaaa"]);

    tracker.poll("s1", "192.0.2.7", VLC);
    expect(tracker.list().map(({ viewer, since }) => ({ viewer, since }))).toEqual([
      { viewer: "aaaaaaaa", since: new Date(1_000_000).toISOString() },
      { viewer: "external2", since: new Date(1_030_001).toISOString() },
    ]);
  });

  test("come back as a new viewer after a pause, even when nothing looked at the viewers meanwhile", () => {
    const { tracker, clock } = viewers();
    tracker.poll("s1", "192.0.2.7", VLC);
    clock.now += 45_000;
    tracker.poll("s1", "192.0.2.7", VLC);
    expect(tracker.list()).toEqual([
      { viewer: "external2", stream: "s1", device: "VLC", since: new Date(1_045_000).toISOString() },
    ]);
  });

  test("go with their stream, and make room like the others", () => {
    const { tracker } = viewers(2);
    tracker.poll("s1", "192.0.2.7", VLC);
    tracker.poll("s2", "192.0.2.8", VLC);
    tracker.forgetStream("s1");
    expect(tracker.list().map(({ viewer }) => viewer)).toEqual(["external2"]);
    // Asking again after its stream went: a new viewer.
    tracker.poll("s1", "192.0.2.7", VLC);
    tracker.report("aaaaaaaa", "s1", "Chrome");
    // The one heard from longest ago made room, and counts again from its next request, as a new viewer.
    expect(tracker.list().map(({ viewer }) => viewer)).toEqual(["external3", "aaaaaaaa"]);
    tracker.poll("s2", "192.0.2.8", VLC);
    expect(tracker.list().map(({ viewer }) => viewer)).toEqual(["aaaaaaaa", "external4"]);
  });

  test("lose their id to a page that reports under it, and get a new one", () => {
    const { tracker } = viewers();
    tracker.poll("s1", "192.0.2.7", VLC);
    // Ids are public (`GET /api/viewers`), and any page can report under any id.
    tracker.report("external1", "s2", "Chrome");
    tracker.poll("s1", "192.0.2.7", VLC);
    expect(tracker.list().map(({ viewer, stream, device }) => `${viewer} ${stream} ${device}`)).toEqual([
      "external1 s2 Chrome",
      "external2 s1 VLC",
    ]);
    // And one a page closed is gone until it asks again.
    tracker.report("external2", null, "Chrome");
    expect(tracker.count("s1")).toBe(0);
    tracker.poll("s1", "192.0.2.7", VLC);
    expect(tracker.list().at(-1)).toMatchObject({ viewer: "external3", stream: "s1" });
  });

  test("get an id like a page's when none is given", () => {
    const tracker = new Viewers({ pingMs: 60_000 });
    tracker.poll("s1", "192.0.2.7", VLC);
    tracker.poll("s1", "192.0.2.8", VLC);
    const ids = tracker.list().map(({ viewer }) => viewer);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[a-z0-9]{16}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });
});

test.each([
  [
    "Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2 Build/STT1.211025.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Chrome on TV",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    "Chrome on Android",
  ],
  ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox on Linux"],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    "Edge on Windows",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Safari on iOS",
  ],
  ["curl/8.5.0", "Browser"],
  [undefined, "Browser"],
])("describes %s as %s", (userAgent, expected) => {
  expect(describeDevice(userAgent)).toBe(expected);
});

test.each([
  [VLC, "VLC"],
  ["VLC/3.6.0 LibVLC/3.0.21 (Linux; Android 14)", "VLC on Android"],
  [
    "Kodi/21.0 (Linux; Android 12; BRAVIA 4K VH2 Build/STT1.211025.001) Android/12 Sys_CPU/arm64-v8a App_Bitness/64 Version/21.0-(21.0.0)-Git:20240401-0f5b8d2",
    "Kodi on TV",
  ],
  ["Kodi/21.0 (X11; Linux x86_64) Ubuntu/24.04 App_Bitness/64 Version/21.0-(21.0.0)", "Kodi on Linux"],
  ["com.example.player/1.4 (Linux;Android 13) ExoPlayerLib/2.19.1", "ExoPlayer on Android"],
  ["Player/2.0 (Linux;Android 14) AndroidXMedia3/1.4.1", "ExoPlayer on Android"],
  ["libmpv", "mpv"],
  ["mpv 0.32.0", "mpv"],
  [FFMPEG, "ffmpeg"],
  // A browser that plays the playlist by itself.
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Safari on iOS",
  ],
  ["curl/8.5.0", "External player"],
  ["stagefright/1.2 (Linux;Android 13)", "External player on Android"],
  [undefined, "External player"],
])("describes the player %s as %s", (userAgent, expected) => {
  expect(describePlayer(userAgent)).toBe(expected);
});
