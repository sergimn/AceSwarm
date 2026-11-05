import { describe, expect, test } from "vitest";
import { describeDevice, Viewers } from "../src/viewers.ts";

function viewers(maxViewers?: number) {
  const clock = { now: 1_000_000 };
  const tracker = new Viewers({
    pingMs: 60_000,
    now: () => clock.now,
    ...(maxViewers !== undefined && { maxViewers }),
  });
  return { tracker, clock };
}

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
