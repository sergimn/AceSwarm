import { describe, expect, it } from "vitest";
import { OUTAGE_TOLERANT_LOADING, retryThroughOutages } from "../src/hls-config.ts";

const retry = retryThroughOutages.shouldRetry!;
const response = (code: number) => ({ url: "/hls/s1/full/index.m3u8", code });

describe("retryThroughOutages", () => {
  it("retries refused connections, which have no HTTP status, while the controller restarts", () => {
    expect(retry(retryThroughOutages, 0, false, response(0), false)).toBe(true);
    expect(retry(retryThroughOutages, retryThroughOutages.maxNumRetry - 1, false, response(0), false)).toBe(true);
  });

  it("gives up after its retries", () => {
    expect(retry(retryThroughOutages, retryThroughOutages.maxNumRetry, false, response(0), false)).toBe(false);
  });

  it("leaves other errors to the default rule", () => {
    // A 404 is never retried; the default rule retries a 502.
    expect(retry(retryThroughOutages, 0, false, response(404), false)).toBe(false);
    expect(retry(retryThroughOutages, 0, false, response(502), true)).toBe(true);
  });

  it("rides out more than ten seconds of outage", () => {
    let waited = 0;
    for (let count = 0; count < retryThroughOutages.maxNumRetry; count += 1) {
      waited += Math.min(2 ** count * retryThroughOutages.retryDelayMs, retryThroughOutages.maxRetryDelayMs);
    }
    expect(waited).toBeGreaterThan(10_000);
  });

  it("applies to playlists and segments", () => {
    expect(OUTAGE_TOLERANT_LOADING.playlistLoadPolicy?.default.errorRetry).toBe(retryThroughOutages);
    expect(OUTAGE_TOLERANT_LOADING.fragLoadPolicy?.default.errorRetry).toBe(retryThroughOutages);
  });

  it("keeps hls.js's own tries after a timeout", () => {
    expect(OUTAGE_TOLERANT_LOADING.playlistLoadPolicy?.default.timeoutRetry?.maxNumRetry).toBe(2);
    expect(OUTAGE_TOLERANT_LOADING.fragLoadPolicy?.default.timeoutRetry?.maxNumRetry).toBe(4);
  });
});
