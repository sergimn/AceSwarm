import type { HlsConfig, LoadPolicy, RetryConfig } from "hls.js/light";

/** How many times a playlist or segment load that failed is tried again, about every second. */
const OUTAGE_RETRIES = 12;

/**
 * Playlists and segments come through the controller, which is gone for a moment while it
 * restarts (after an update, say). Its connections are refused then, and hls.js doesn't retry a
 * request without an HTTP status by default (it takes it for a CORS error): the error is fatal and
 * the player starts over, which shows a few seconds of black. Retrying such errors for a while
 * keeps the picture going from the buffer.
 *
 * Other errors keep hls.js's rule for which ones are retried (a 404 isn't, a 502 is), but get these
 * tries too: 12, a second apart at most, where hls.js tries a playlist 2 more times and a segment 6,
 * with waits up to 8 seconds. That also rides out a transcoder that restarts (the proxy answers 502
 * then). Timeouts keep hls.js's own tries.
 */
export const retryThroughOutages: RetryConfig = {
  maxNumRetry: OUTAGE_RETRIES,
  retryDelayMs: 500,
  maxRetryDelayMs: 1000,
  shouldRetry: (config, retryCount, _isTimeout, response, retry) =>
    retry || (response?.code === 0 && retryCount < (config?.maxNumRetry ?? 0)),
};

/** hls.js's own load policy (as of 1.7) with `retryThroughOutages` for errors. */
function loadPolicy(maxLoadTimeMs: number, timeoutRetries: number): LoadPolicy {
  return {
    default: {
      maxTimeToFirstByteMs: 10_000,
      maxLoadTimeMs,
      timeoutRetry: { maxNumRetry: timeoutRetries, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: retryThroughOutages,
    },
  };
}

/** Load policies for every player, the full screen one and the tile previews. */
export const OUTAGE_TOLERANT_LOADING: Partial<HlsConfig> = {
  playlistLoadPolicy: loadPolicy(20_000, 2),
  fragLoadPolicy: loadPolicy(120_000, 4),
};
