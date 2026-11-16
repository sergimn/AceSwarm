import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@aceswarm/shared/api-types";
import { RECONNECT_DELAY_MS, SILENT_RECONNECT_MS, subscribeSnapshots, type ConnectionStatus } from "../src/api.ts";

type Listener = (event: unknown) => void;

/** Just enough of the browser's EventSource: what the page does with one, and what the browser does to it. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  readonly url: string;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, event: unknown = {}): void {
    const listeners = this.listeners.get(type) ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  opens(): void {
    this.readyState = FakeEventSource.OPEN;
    this.emit("open");
  }

  /** The browser retries by itself after a dropped connection. */
  drops(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.emit("error");
  }

  /** After an HTTP error answer the browser gives up for good. */
  failsForGood(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.emit("error");
  }

  sends(snapshot: Partial<Snapshot>): void {
    this.emit("snapshot", { data: JSON.stringify(snapshot) });
  }
}

function last<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1];
}

const current = (): FakeEventSource => last(FakeEventSource.instances)!;

describe("subscribeSnapshots", () => {
  const snapshots: Partial<Snapshot>[] = [];
  const statuses: ConnectionStatus[] = [];
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    snapshots.length = 0;
    statuses.length = 0;
    stop = subscribeSnapshots(
      (snapshot) => {
        snapshots.push(snapshot);
      },
      (status) => {
        statuses.push(status);
      },
    );
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("reports the connection and passes the snapshots on", () => {
    expect(statuses).toEqual(["connecting"]);
    expect(current().url).toBe("/api/events");
    current().opens();
    current().sends({ generatedAt: "2026-11-16T12:00:00Z" });
    expect(statuses).toEqual(["connecting", "live"]);
    expect(snapshots).toEqual([{ generatedAt: "2026-11-16T12:00:00Z" }]);
  });

  it("leaves a dropped connection to the browser, which retries by itself", () => {
    current().opens();
    current().drops();
    expect(last(statuses)).toBe("reconnecting");
    vi.advanceTimersByTime(RECONNECT_DELAY_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("opens a new connection 3 s after the browser gave up, which it does after an HTTP error answer", () => {
    current().opens();
    current().failsForGood();
    expect(last(statuses)).toBe("reconnecting");
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(RECONNECT_DELAY_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    current().opens();
    current().sends({ generatedAt: "2026-11-16T12:01:00Z" });
    expect(last(statuses)).toBe("live");
    expect(snapshots).toHaveLength(1);
    // A connection that delivers is left alone.
    for (let seconds = 0; seconds < 30; seconds += 2) {
      vi.advanceTimersByTime(2000);
      current().sends({});
    }
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("keeps trying every 3 s for as long as the controller is away, one connection at a time", () => {
    current().opens();
    current().failsForGood();
    // Past the time a silent connection is replaced after: the watchdog stays out of the way.
    for (let attempt = 1; attempt <= 8; attempt++) {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS);
      expect(FakeEventSource.instances).toHaveLength(attempt + 1);
      current().failsForGood();
    }
    vi.advanceTimersByTime(RECONNECT_DELAY_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(9);
  });

  it("leaves a connection that is still being made alone until it has had its time, whatever came before", () => {
    // It delivered a snapshot, dropped for good, and the next one never answers.
    current().opens();
    current().sends({});
    vi.advanceTimersByTime(1000);
    current().failsForGood();
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
    const hung = current();

    // The silence counts from when it was made, not from the last snapshot of the one before.
    vi.advanceTimersByTime(SILENT_RECONNECT_MS - 2000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(hung.readyState).toBe(FakeEventSource.CONNECTING);
    vi.advanceTimersByTime(4000);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(hung.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("counts the silence of a slow connection from when it opened", () => {
    vi.advanceTimersByTime(SILENT_RECONNECT_MS - 1000);
    current().opens();
    vi.advanceTimersByTime(4000);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(SILENT_RECONNECT_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("opens one connection, not two, when a silent one fails for good while the next is awaited", () => {
    current().opens();
    current().sends({});
    // Silent for longer than the watchdog allows, but the failure comes first.
    vi.advanceTimersByTime(SILENT_RECONNECT_MS + 500);
    expect(FakeEventSource.instances).toHaveLength(1);
    current().failsForGood();
    vi.advanceTimersByTime(RECONNECT_DELAY_MS + 2000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("replaces a connection that is open but delivers nothing", () => {
    const first = current();
    first.opens();
    first.sends({});
    // A snapshot every 2 seconds keeps it.
    for (let seconds = 0; seconds < 30; seconds += 2) {
      vi.advanceTimersByTime(2000);
      first.sends({});
    }
    expect(FakeEventSource.instances).toHaveLength(1);

    // Then nothing arrives, and no error is reported (a lost Wi-Fi).
    vi.advanceTimersByTime(SILENT_RECONNECT_MS + 2000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(last(statuses)).toBe("reconnecting");

    current().opens();
    current().sends({});
    expect(last(statuses)).toBe("live");
  });

  it("stops everything when the page unsubscribes, with a retry pending or without", () => {
    const first = current();
    first.failsForGood();
    stop();
    vi.advanceTimersByTime(RECONNECT_DELAY_MS + SILENT_RECONNECT_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("stops the watchdog when the page unsubscribes", () => {
    const first = current();
    first.opens();
    stop();
    vi.advanceTimersByTime(SILENT_RECONNECT_MS * 3);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
  });
});
