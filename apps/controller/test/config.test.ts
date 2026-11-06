import { describe, expect, it } from "vitest";
import { ENGINE_MEMORY_OVERHEAD_MB, loadConfig, maxEngineMemoryCacheMb, minEngineMemoryMb } from "../src/config.ts";
import { engineEnvironment } from "../src/engines.ts";

describe("engine memory settings", () => {
  it("defaults to a memory cache that fits under the engine's memory limit, below the alert", () => {
    const config = loadConfig({});
    expect(config.ENGINE_MEMORY_CACHE_MB).toBe(128);
    expect(config.ENGINE_MEMORY_MB).toBe(512);
    expect(config.ENGINE_MEMORY_MB).toBeGreaterThanOrEqual(minEngineMemoryMb(config.ENGINE_MEMORY_CACHE_MB));
    expect((config.ENGINE_MEMORY_CACHE_MB + ENGINE_MEMORY_OVERHEAD_MB) / config.ENGINE_MEMORY_MB).toBeLessThan(0.85);
  });

  it("asks for 256 MB of room besides the cache, and for a full cache to stay under the 85% alert", () => {
    expect(minEngineMemoryMb(128)).toBe(386);
    expect(minEngineMemoryMb(256)).toBe(537);
    expect(minEngineMemoryMb(512)).toBe(838);
    expect(minEngineMemoryMb(768)).toBe(1139);
    expect(minEngineMemoryMb(1024)).toBe(1440);
  });

  it("refuses a limit too small for the memory cache, and says what to set", () => {
    expect(() => loadConfig({ ENGINE_MEMORY_MB: "768", ENGINE_MEMORY_CACHE_MB: "768" })).toThrow(
      /ENGINE_MEMORY_MB=768 is too small for ENGINE_MEMORY_CACHE_MB=768\. .*256 MB.*up to 200 MB.*at 85% of the limit.*at least 1139, or lower ENGINE_MEMORY_CACHE_MB to at most 452\n.*at ENGINE_MEMORY_MB/s,
    );
    // A limit too small for any cache only asks for a larger limit.
    expect(() => loadConfig({ ENGINE_MEMORY_MB: "200", ENGINE_MEMORY_CACHE_MB: "1" })).toThrow(/at least 257\n/);
    expect(() => loadConfig({ ENGINE_MEMORY_MB: "1138", ENGINE_MEMORY_CACHE_MB: "768" })).toThrow();
    expect(loadConfig({ ENGINE_MEMORY_MB: "1139", ENGINE_MEMORY_CACHE_MB: "768" }).ENGINE_MEMORY_CACHE_MB).toBe(768);
    expect(loadConfig({ ENGINE_MEMORY_MB: "768", ENGINE_MEMORY_CACHE_MB: "256" }).ENGINE_MEMORY_MB).toBe(768);
  });

  it("names the largest cache that fits a limit, consistently with the minimum limit", () => {
    expect(maxEngineMemoryCacheMb(768)).toBe(452);
    expect(maxEngineMemoryCacheMb(1024)).toBe(670);
    expect(maxEngineMemoryCacheMb(1440)).toBe(1024);
    for (let limitMb = 257; limitMb <= 4096; limitMb += 1) {
      const cacheMb = maxEngineMemoryCacheMb(limitMb);
      expect(minEngineMemoryMb(cacheMb), String(limitMb)).toBeLessThanOrEqual(limitMb);
      expect(minEngineMemoryMb(cacheMb + 1), String(limitMb)).toBeGreaterThan(limitMb);
    }
  });

  it("accepts any limit when the cache is left to the engine, and no limit at all", () => {
    expect(loadConfig({ ENGINE_MEMORY_MB: "300", ENGINE_MEMORY_CACHE_MB: "0" }).ENGINE_MEMORY_MB).toBe(300);
    expect(loadConfig({ ENGINE_MEMORY_MB: "0", ENGINE_MEMORY_CACHE_MB: "2048" }).ENGINE_MEMORY_CACHE_MB).toBe(2048);
  });

  it("rejects a cache size that is not a whole number of megabytes in range", () => {
    for (const value of ["512 --evil", "-1", "1.5", "1e15", "65537"]) {
      expect(() => loadConfig({ ENGINE_MEMORY_CACHE_MB: value, ENGINE_MEMORY_MB: "0" }), value).toThrow(
        /ENGINE_MEMORY_CACHE_MB/,
      );
    }
  });

  it("hands the cache size to the engine in bytes", () => {
    expect(
      engineEnvironment({ gatewayIp: "172.31.250.2", dns: "1.1.1.1,9.9.9.9", memoryCacheMb: 512, extraFlags: "--x 1" }),
    ).toEqual([
      "ACESWARM_GATEWAY=172.31.250.2",
      "ACESWARM_DNS=1.1.1.1,9.9.9.9",
      "ACESWARM_MEMORY_CACHE_BYTES=536870912",
      "ACESWARM_ENGINE_FLAGS=--x 1",
    ]);
    expect(engineEnvironment({ gatewayIp: "x", dns: "y", memoryCacheMb: 0, extraFlags: "" })).toContain(
      "ACESWARM_MEMORY_CACHE_BYTES=0",
    );
  });
});
