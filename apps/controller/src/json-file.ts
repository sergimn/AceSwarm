import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Writes JSON atomically (temp file + rename) so a crash never leaves a half-written file. */
export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
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
