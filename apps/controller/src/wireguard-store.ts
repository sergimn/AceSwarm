import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WireguardProfileView } from "@aceswarm/shared/api-types";
import { isValidProfileName, parseWireguardConfig, summarizeWireguard } from "@aceswarm/shared/wireguard";
import { Mutex } from "./json-file.ts";

export class InvalidProfileError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid WireGuard profile: ${problems.join("; ")}`);
    this.name = "InvalidProfileError";
    this.problems = problems;
  }
}

/**
 * Stores WireGuard profiles as `<data>/wireguard/<name>.conf` (mode 0600). The network gateway
 * mounts the same directory read-only and brings one tunnel up per file.
 */
export class WireguardStore {
  readonly directory: string;
  private readonly mutex = new Mutex();

  constructor(dataDir: string) {
    this.directory = join(dataDir, "wireguard");
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async list(): Promise<WireguardProfileView[]> {
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    const profiles: WireguardProfileView[] = [];
    const files = entries.filter((file) => file.endsWith(".conf")).toSorted((a, b) => a.localeCompare(b));
    for (const entry of files) {
      const name = entry.slice(0, -".conf".length);
      const path = join(this.directory, entry);
      const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      const parsed = parseWireguardConfig(text);
      const summary = parsed.ok ? summarizeWireguard(parsed.config) : { endpoint: null, addresses: [] };
      profiles.push({ name, ...summary, createdAt: info.mtime.toISOString() });
    }
    return profiles;
  }

  async save(name: string, text: string): Promise<WireguardProfileView> {
    if (!isValidProfileName(name)) {
      throw new InvalidProfileError(["name must be 1-32 characters: lower case letters, digits, '-' or '_'"]);
    }
    const parsed = parseWireguardConfig(text);
    if (!parsed.ok) {
      throw new InvalidProfileError(parsed.errors);
    }
    return this.mutex.run(async () => {
      const path = join(this.directory, `${name}.conf`);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      return {
        name,
        ...summarizeWireguard(parsed.config),
        createdAt: new Date().toISOString(),
      };
    });
  }

  async remove(name: string): Promise<boolean> {
    if (!isValidProfileName(name)) {
      return false;
    }
    return this.mutex.run(async () => {
      const path = join(this.directory, `${name}.conf`);
      const existed = await stat(path)
        .then(() => true)
        .catch(() => false);
      await rm(path, { force: true });
      return existed;
    });
  }
}
