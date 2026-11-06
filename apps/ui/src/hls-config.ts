import type { HlsConfig, LoadPolicy, RetryConfig } from "hls.js/light";

/** How many times a playlist or segment load that failed is tried again, about every second. */
const OUTAGE_RETRIES = 12;

/**
 * Playlists and segments come through the controller, which is gone for a moment while it
 * restarts (after an update, say). Its connections are refused then, and hls.js doesn't retry a
 * request without an HTTP status by default (it takes it for a CORS error): the error is fatal and
 * the player starts over, which shows a few seconds of black. Retrying such errors for a while
 * keeps the picture going from the buffer. Other errors keep the default rule.
 */
export const retryThroughOutages: RetryConfig = {
  maxNumRetry: OUTAGE_RETRIES,
  retryDelayMs: 500,
  maxRetryDelayMs: 1000,
  shouldRetry: (config, retryCount, _isTimeout, response, retry) =>
    retry || (response?.code === 0 && retryCount < (config?.maxNumRetry ?? 0)),
};

function loadPolicy(maxLoadTimeMs: number): LoadPolicy {
  return {
    default: {
      maxTimeToFirstByteMs: 10_000,
      maxLoadTimeMs,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: retryThroughOutages,
    },
  };
}

/** Load policies for every player, the full screen one and the tile previews. */
export const OUTAGE_TOLERANT_LOADING: Partial<HlsConfig> = {
  playlistLoadPolicy: loadPolicy(20_000),
  fragLoadPolicy: loadPolicy(120_000),
};
