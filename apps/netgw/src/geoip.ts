import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Logger } from "@aceswarm/shared/logger";
import { describeError } from "@aceswarm/shared/http";
import { Reader, type CountryResponse } from "maxmind";

export interface GeoLookup {
  /** ISO country code (upper case) of an address, if known. */
  country(ip: string): string | undefined;
}

/**
 * Fixed address-to-country entries, consulted before the database. Used by the end-to-end tests
 * (whose runners reach each other on 192.0.2.0/24, which no database knows) and for private peers.
 */
export class StaticGeoLookup implements GeoLookup {
  private readonly entries: ReadonlyMap<string, string>;
  private readonly fallback: GeoLookup;

  constructor(entries: ReadonlyMap<string, string>, fallback: GeoLookup) {
    this.entries = entries;
    this.fallback = fallback;
  }

  /** Parses `ip=CC` items, ignoring malformed ones. */
  static parse(items: readonly string[]): Map<string, string> {
    const entries = new Map<string, string>();
    for (const item of items) {
      const match = /^([\d.]+)=([a-z]{2})$/i.exec(item.trim());
      if (match?.[1] !== undefined && match[2] !== undefined) {
        entries.set(match[1], match[2].toUpperCase());
      }
    }
    return entries;
  }

  country(ip: string): string | undefined {
    return this.entries.get(ip) ?? this.fallback.country(ip);
  }
}

const MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;

function monthUrl(template: string, date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return template.replaceAll("{YYYY}", () => year).replaceAll("{MM}", () => month);
}

/**
 * Country lookups backed by the free DB-IP Lite database (CC BY 4.0, attribution shown in the
 * UI). The file is downloaded on first start and refreshed when it is older than a month.
 */
export class GeoIpDatabase implements GeoLookup {
  private reader: Reader<CountryResponse> | undefined;
  private readonly path: string;
  private readonly logger: Logger;

  constructor(path: string, logger: Logger) {
    this.path = path;
    this.logger = logger.child({ component: "geoip" });
  }

  get loaded(): boolean {
    return this.reader !== undefined;
  }

  country(ip: string): string | undefined {
    const code = this.reader?.get(ip)?.country?.iso_code;
    return code?.toUpperCase();
  }

  async load(): Promise<void> {
    try {
      this.reader = new Reader<CountryResponse>(await readFile(this.path));
      this.logger.info({ path: this.path }, "GeoIP database loaded");
    } catch (error) {
      this.logger.warn({ path: this.path, err: describeError(error) }, "GeoIP database not available");
    }
  }

  /** Downloads this month's (or last month's) database when the local copy is missing or old. */
  async refresh(template: string, now = new Date()): Promise<void> {
    const age = await stat(this.path)
      .then((info) => now.getTime() - info.mtime.getTime())
      .catch(() => Infinity);
    if (age < MAX_AGE_MS) {
      if (this.reader === undefined) {
        await this.load();
      }
      return;
    }
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    for (const url of [monthUrl(template, now), monthUrl(template, lastMonth)]) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        const data = gunzipSync(Buffer.from(await response.arrayBuffer()));
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(`${this.path}.tmp`, data);
        await rename(`${this.path}.tmp`, this.path);
        this.logger.info({ url }, "GeoIP database downloaded");
        await this.load();
        return;
      } catch (error) {
        this.logger.warn({ url, err: describeError(error) }, "GeoIP download failed");
      }
    }
    if (this.reader === undefined) {
      await this.load();
    }
  }
}
