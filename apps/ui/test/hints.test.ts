import { describe, expect, it } from "vitest";
import { favouritePathHint, sharedEnginesHint } from "../src/hints.ts";

describe("sharedEnginesHint", () => {
  it("says an engine of its own when off", () => {
    expect(sharedEnginesHint(undefined)).toBe("Off: every stream has an engine of its own.");
    expect(sharedEnginesHint({ enabled: false, maxFailures: 2, failureWindowSeconds: 60 })).toContain("Off:");
  });

  it("lists every case that replaces a shared engine, with the configured limits", () => {
    const hint = sharedEnginesHint({ enabled: true, maxFailures: 3, failureWindowSeconds: 90 });
    expect(hint).toContain("replaced when a stream someone is watching fails");
    expect(hint).toContain("more than 3 of its streams fail within 90 s");
    expect(hint).toContain("every stream on it fails");
    expect(hint).toContain("stops answering");
    expect(hint).toContain("press Restart on one of its streams");
    expect(hint).not.toContain("restarts only");
  });
});

describe("favouritePathHint", () => {
  const vpn = { id: "wg:vpn", label: "vpn", unavailable: null };

  it("says streams stay on their path with no favourite", () => {
    const none = { text: "None: a stream stays on its path until that fails.", caution: false };
    expect(favouritePathHint(undefined, 20, true)).toEqual(none);
    expect(favouritePathHint({ id: null, label: "None", unavailable: null }, 20, true)).toEqual(none);
  });

  it("says when a stream moves, with the configured time", () => {
    const hint = favouritePathHint(vpn, 45, true);
    expect(hint.caution).toBe(false);
    expect(hint.text).toContain("vpn: a stream on another path moves to it");
    expect(hint.text).toContain("hot for 45 s without a break");
    expect(hint.text).toContain("New streams start on it.");
  });

  it("warns that nothing moves by itself while hot standby is off", () => {
    const hint = favouritePathHint(vpn, 20, false);
    expect(hint.caution).toBe(true);
    expect(hint.text).toContain("Hot standby is off");
    expect(hint.text).toContain("new streams start on it");
  });

  it("warns why no stream can move to a favourite that is down, off or unknown", () => {
    expect(favouritePathHint({ ...vpn, unavailable: "down" }, 20, true)).toEqual({
      text: "vpn is down: streams stay where they are, and move to it once it is back.",
      caution: true,
    });
    expect(favouritePathHint({ id: "direct", label: "Direct", unavailable: "off" }, 20, true)).toEqual({
      text: "Direct is off while WireGuard only is on: streams stay where they are.",
      caution: true,
    });
    const unknown = favouritePathHint({ ...vpn, unavailable: "unknown" }, 20, true);
    expect(unknown.caution).toBe(true);
    expect(unknown.text).toContain("gateway doesn't report vpn");
  });

  it("doesn't promise a move to a path that comes back while hot standby is off", () => {
    const off = "Hot standby is off, so none moves to it by itself.";
    expect(favouritePathHint({ ...vpn, unavailable: "down" }, 20, false)).toEqual({
      text: `vpn is down: streams stay where they are. ${off}`,
      caution: true,
    });
    expect(favouritePathHint({ ...vpn, unavailable: "unknown" }, 20, false)).toEqual({
      text: `The network gateway doesn't report vpn: streams stay where they are. ${off}`,
      caution: true,
    });
    expect(favouritePathHint({ id: "direct", label: "Direct", unavailable: "off" }, 20, false)).toEqual({
      text: `Direct is off while WireGuard only is on: streams stay where they are. ${off}`,
      caution: true,
    });
  });
});
