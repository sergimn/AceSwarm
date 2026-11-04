import { describe, expect, it } from "vitest";
import { behaviorFor, buildSourceArgs, hueFor, idKindFor } from "../src/behavior.ts";
import { SessionStore } from "../src/sessions.ts";

describe("mock behaviours", () => {
  it("picks a behaviour from the ID prefix", () => {
    expect(behaviorFor("dead".padEnd(40, "0"))).toBe("dead");
    expect(behaviorFor("0BAD".padEnd(40, "0"))).toBe("stall");
    expect(behaviorFor("beef".padEnd(40, "0"))).toBe("vpn-only");
    expect(behaviorFor("ec0d".padEnd(40, "0"))).toBe("mpeg2");
    expect(behaviorFor("1234".padEnd(40, "0"))).toBe("normal");
  });

  it("decides the ID kind from the last hex digit", () => {
    expect(idKindFor("a".repeat(39) + "7")).toBe("content-id");
    expect(idKindFor("a".repeat(39) + "8")).toBe("infohash");
    expect(idKindFor("a".repeat(39) + "f")).toBe("infohash");
  });

  it("gives every stream a stable hue", () => {
    const id = "6d325cda6ed591647ef5e91edd043147bce8be30";
    expect(hueFor(id)).toBe(hueFor(id));
    expect(hueFor(id)).toBeGreaterThanOrEqual(0);
    expect(hueFor(id)).toBeLessThan(360);
  });

  it("produces MPEG-TS on stdout", () => {
    const h264 = buildSourceArgs({ size: "320x180", fps: 25, hue: 10, codec: "h264" });
    expect(h264.slice(-3)).toEqual(["-f", "mpegts", "pipe:1"]);
    expect(h264).toContain("libx264");
    expect(buildSourceArgs({ size: "320x180", fps: 25, hue: 10, codec: "mpeg2" })).toContain("mpeg2video");
  });
});

describe("SessionStore", () => {
  it("replaces a player's previous session and reports engine-like stats", () => {
    let now = 0;
    const store = new SessionStore(() => now);
    const first = store.create("a".repeat(40), "player", "normal");
    const second = store.create("a".repeat(40), "player", "normal");
    expect(store.get(first.id)).toBeUndefined();
    expect(store.stats(second, 3)).toMatchObject({ status: "prebuf", peers: 0, speed_down: 0 });

    store.addBytes(second, 1024 * 100);
    now = 1000;
    store.addBytes(second, 1024 * 100);
    expect(store.stats(second, 3)).toMatchObject({ status: "dl", peers: 3, speed_down: 100 });

    expect(store.stop(second.id)).toBe(true);
    expect(store.stop(second.id)).toBe(false);
  });
});
