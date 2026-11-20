import { describe, expect, it } from "vitest";
import { ENGINE_MEMORY_OVERHEAD_MB, loadConfig, maxEngineMemoryCacheMb, minEngineMemoryMb } from "../src/config.ts";
import { engineEnvironment, engineMounts } from "../src/engines.ts";

/** The cache settings of an engine that keeps its cache in memory. */
const inMemory = { cacheDir: "", diskCacheMb: 256 };

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
      engineEnvironment({
        gatewayIp: "172.31.250.2",
        dns: "1.1.1.1,9.9.9.9",
        memoryCacheMb: 512,
        extraFlags: "--x 1",
        ...inMemory,
      }),
    ).toEqual([
      "ACESWARM_GATEWAY=172.31.250.2",
      "ACESWARM_DNS=1.1.1.1,9.9.9.9",
      "ACESWARM_MEMORY_CACHE_BYTES=536870912",
      "ACESWARM_DISK_CACHE_BYTES=0",
      "ACESWARM_ENGINE_FLAGS=--x 1",
    ]);
    expect(engineEnvironment({ gatewayIp: "x", dns: "y", memoryCacheMb: 0, extraFlags: "", ...inMemory })).toContain(
      "ACESWARM_MEMORY_CACHE_BYTES=0",
    );
  });
});

describe("engine cache on disk", () => {
  it("keeps the cache in memory by default", () => {
    const config = loadConfig({});
    expect(config.ENGINE_CACHE_DIR).toBe("");
    expect(config.ENGINE_DISK_CACHE_MB).toBe(256);
    expect(engineMounts(inMemory)).toEqual([]);
    // The size alone changes nothing: without a folder there is no cache on disk.
    expect(engineEnvironment({ gatewayIp: "x", dns: "y", memoryCacheMb: 128, extraFlags: "", ...inMemory })).toContain(
      "ACESWARM_DISK_CACHE_BYTES=0",
    );
  });

  it("mounts the folder into the engine and hands it the cache size in bytes", () => {
    const onDisk = { cacheDir: "/mnt/ssd/aceswarm cache", diskCacheMb: 300 };
    expect(engineMounts(onDisk)).toEqual([{ Type: "bind", Source: "/mnt/ssd/aceswarm cache", Target: "/cache" }]);
    expect(engineEnvironment({ gatewayIp: "x", dns: "y", memoryCacheMb: 128, extraFlags: "", ...onDisk })).toEqual([
      "ACESWARM_GATEWAY=x",
      "ACESWARM_DNS=y",
      "ACESWARM_MEMORY_CACHE_BYTES=134217728",
      "ACESWARM_DISK_CACHE_BYTES=314572800",
      "ACESWARM_ENGINE_FLAGS=",
    ]);
  });

  it("only takes the full path of a folder", () => {
    for (const dir of ["/mnt/ssd/aceswarm-cache", "/srv/cache/", "/mnt/My Disk/cache:1", "/var/lib/..cache"]) {
      expect(loadConfig({ ENGINE_CACHE_DIR: dir }, "x64").ENGINE_CACHE_DIR, dir).toBe(dir);
    }
    for (const dir of ["cache", "./cache", "~/cache", "/", "//", "/mnt/../etc", "/mnt/./cache", "/mnt/a\nb", " /mnt"]) {
      expect(() => loadConfig({ ENGINE_CACHE_DIR: dir }, "x64"), dir).toThrow(
        /ENGINE_CACHE_DIR has to be the full path/,
      );
    }
  });

  it("takes a cache size from 50 MB, the least the engine gives a stream", () => {
    expect(loadConfig({ ENGINE_DISK_CACHE_MB: "50" }).ENGINE_DISK_CACHE_MB).toBe(50);
    expect(loadConfig({ ENGINE_DISK_CACHE_MB: "20480" }).ENGINE_DISK_CACHE_MB).toBe(20_480);
    for (const value of ["49", "0", "-1", "1.5", "256 --evil", "1048577"]) {
      expect(() => loadConfig({ ENGINE_DISK_CACHE_MB: value }), value).toThrow(/ENGINE_DISK_CACHE_MB/);
    }
  });

  it("lets the memory limit go down to what an engine without a memory cache needs", () => {
    const onDisk = { ENGINE_CACHE_DIR: "/mnt/ssd/cache" };
    // Too small for the default 128 MB memory cache, which stays empty with the cache on disk.
    expect(() => loadConfig({ ENGINE_MEMORY_MB: "256" })).toThrow(/too small for ENGINE_MEMORY_CACHE_MB=128/);
    expect(loadConfig({ ...onDisk, ENGINE_MEMORY_MB: "256" }, "x64").ENGINE_MEMORY_MB).toBe(256);
    expect(loadConfig({ ...onDisk, ENGINE_MEMORY_MB: "0" }, "x64").ENGINE_MEMORY_MB).toBe(0);
    expect(() => loadConfig({ ...onDisk, ENGINE_MEMORY_MB: "255" }, "x64")).toThrow(
      /ENGINE_MEMORY_MB=255 is too small\. With its cache on disk \(ENGINE_CACHE_DIR\) an engine still needs at least 256 MB/,
    );
  });

  it("refuses the folder on arm64, where the engine keeps its cache in memory", () => {
    const onDisk = { ENGINE_CACHE_DIR: "/mnt/ssd/cache" };
    expect(() => loadConfig(onDisk, "arm64")).toThrow(
      /✖ ENGINE_CACHE_DIR is for x86_64 only, and this machine is arm64 .* lower ENGINE_MEMORY_CACHE_MB\n {2}→ at ENGINE_CACHE_DIR/,
    );
    // Said together with whatever else is wrong, so one start names everything to change.
    expect(() => loadConfig({ ...onDisk, ENGINE_MEMORY_MB: "255" }, "arm64")).toThrow(
      /ENGINE_MEMORY_MB=255 is too small[^]*ENGINE_CACHE_DIR is for x86_64 only/,
    );
    // A folder that is no folder is the first thing to say.
    expect(() => loadConfig({ ENGINE_CACHE_DIR: "cache" }, "arm64")).toThrow(/has to be the full path/);
    // Without the folder nothing is refused, and the other settings read the same on both.
    expect(loadConfig({}, "arm64")).toEqual(loadConfig({}, "x64"));
    expect(loadConfig({ ENGINE_DISK_CACHE_MB: "300" }, "arm64").ENGINE_DISK_CACHE_MB).toBe(300);
    expect(loadConfig(onDisk, "x64").ENGINE_CACHE_DIR).toBe("/mnt/ssd/cache");
  });
});

describe("hot standby settings", () => {
  it("keeps standbys on every other path by default, and fails over after 8 s without video", () => {
    const config = loadConfig({});
    expect(config.STANDBY_MAX_PATHS).toBe(0);
    expect(config.STANDBY_FAILOVER_SECONDS).toBe(8);
    expect(loadConfig({ STANDBY_MAX_PATHS: "1", STANDBY_FAILOVER_SECONDS: "3" })).toMatchObject({
      STANDBY_MAX_PATHS: 1,
      STANDBY_FAILOVER_SECONDS: 3,
    });
    expect(() => loadConfig({ STANDBY_FAILOVER_SECONDS: "0" })).toThrow();
  });
});

describe("tile previews", () => {
  it("leaves the choice to each browser unless the admin turned on low CPU previews", () => {
    expect(loadConfig({}).LOW_CPU_PREVIEWS).toBe(false);
    // compose.yaml passes "false" while the line in .env stays commented out.
    expect(loadConfig({ LOW_CPU_PREVIEWS: "false" }).LOW_CPU_PREVIEWS).toBe(false);
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      expect(loadConfig({ LOW_CPU_PREVIEWS: value }).LOW_CPU_PREVIEWS, value).toBe(true);
    }
  });
});
