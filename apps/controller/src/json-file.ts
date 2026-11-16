import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** Reads a JSON file, returning `undefined` when it does not exist yet. */
export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Writes JSON atomically, so that a crash or a power cut leaves the old file or the new one, never
 * half of one: a temp file, flushed to the disk, then renamed over the old one. Without the flush
 * some filesystems keep the new name and lose the data, which leaves an empty file.
 */
export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

/** Serializes async operations so concurrent API calls cannot interleave file writes. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    // Run after the previous operation whether it succeeded or failed.
    const result = this.tail.catch(() => undefined).then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
