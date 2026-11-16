import { afterEach, describe, expect, it, vi } from "vitest";
import { formatClock, onTick } from "../src/clock.ts";

describe("formatClock", () => {
  it("shows local time as HH:MM on a 24-hour clock", () => {
    expect(formatClock(new Date(2026, 10, 14, 0, 5))).toBe("00:05");
    expect(formatClock(new Date(2026, 10, 14, 9, 30))).toBe("09:30");
    expect(formatClock(new Date(2026, 10, 14, 13, 7))).toBe("13:07");
    expect(formatClock(new Date(2026, 10, 14, 23, 59))).toBe("23:59");
  });
});

describe("onTick", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls every listener once a second, on one shared timer", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    onTick(first);
    onTick(second);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenCalledTimes(3);
  });
});
