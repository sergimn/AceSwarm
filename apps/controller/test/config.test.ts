import { describe, expect, it } from "vitest";
import { ENGINE_MEMORY_OVERHEAD_MB, loadConfig } from "../src/config.ts";
import { engineEnvironment } from "../src/engines.ts";

describe("engine memory settings", () => {
  it("defaults to a memory cache that fits under the engine's memory limit", () => {
    const config = loadConfig({});
    expect(config.ENGINE_MEMORY_CACHE_MB).toBeGreaterThan(0);
    expect(config.ENGINE_MEMORY_CACHE_MB + ENGINE_MEMORY_OVERHEAD_MB).toBeLessThanOrEqual(config.ENGINE_MEMORY_MB);
  });

  it("refuses a memory cache that leaves the engine too little room under its limit", () => {
    expect(() => loadConfig({ ENGINE_MEMORY_MB: "768", ENGINE_MEMORY_CACHE_MB: "768" })).toThrow(
      /ENGINE_MEMORY_MB \(768\) must be at least ENGINE_MEMORY_CACHE_MB \(768\)/,
    );
    expect(() => loadConfig({ ENGINE_MEMORY_MB: "1023", ENGINE_MEMORY_CACHE_MB: "768" })).toThrow();
    expect(loadConfig({ ENGINE_MEMORY_MB: "1024", ENGINE_MEMORY_CACHE_MB: "768" }).ENGINE_MEMORY_CACHE_MB).toBe(768);
  });

  it("accepts any limit when the cache is left to the engine, and no limit at all", () => {
    expect(loadConfig({ ENGINE_MEMORY_MB: "300", ENGINE_MEMORY_CACHE_MB: "0" }).ENGINE_MEMORY_MB).toBe(300);
    expect(loadConfig({ ENGINE_MEMORY_MB: "0", ENGINE_MEMORY_CACHE_MB: "2048" }).ENGINE_MEMORY_CACHE_MB).toBe(2048);
  });

  it("rejects a cache size that is not a whole number of megabytes", () => {
    expect(() => loadConfig({ ENGINE_MEMORY_CACHE_MB: "512 --evil" })).toThrow(/ENGINE_MEMORY_CACHE_MB/);
    expect(() => loadConfig({ ENGINE_MEMORY_CACHE_MB: "-1" })).toThrow(/ENGINE_MEMORY_CACHE_MB/);
  });

  it("hands the cache size to the engine in bytes", () => {
    const env = engineEnvironment({ gatewayIp: "172.31.250.2", dns: "1.1.1.1", memoryCacheMb: 512, extraFlags: "" });
    expect(env).toContain("ACESWARM_MEMORY_CACHE_BYTES=536870912");
    expect(env).toContain("ACESWARM_GATEWAY=172.31.250.2");
    expect(engineEnvironment({ gatewayIp: "x", dns: "y", memoryCacheMb: 0, extraFlags: "" })).toContain(
      "ACESWARM_MEMORY_CACHE_BYTES=0",
    );
  });
});
