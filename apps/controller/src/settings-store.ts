import { join } from "node:path";
import type { Settings } from "@aceswarm/shared/api-types";
import { describeError } from "@aceswarm/shared/http";
import { z } from "zod";
import { Mutex, readJsonFile, writeJsonFile } from "./json-file.ts";

const fileSchema = z.object({
  version: z.literal(1),
  sharedEngines: z.boolean().default(false),
  hotStandby: z.boolean().default(true),
});

export const DEFAULT_SETTINGS: Settings = { sharedEngines: false, hotStandby: true };

/** Keeps the settings changed from the UI in `<data>/settings.json`, written atomically. */
export class SettingsStore {
  private readonly path: string;
  private readonly mutex = new Mutex();
  private current: Settings = { ...DEFAULT_SETTINGS };

  constructor(dataDir: string) {
    this.path = join(dataDir, "settings.json");
  }

  /** Reads the file. Returns why it could not be read or understood, in which case the defaults apply. */
  async load(): Promise<string | null> {
    try {
      const raw = await readJsonFile(this.path);
      const parsed = raw === undefined ? undefined : fileSchema.safeParse(raw);
      if (parsed?.success === false) {
        return "the settings file has an unknown format";
      }
      this.current =
        parsed === undefined
          ? { ...DEFAULT_SETTINGS }
          : { sharedEngines: parsed.data.sharedEngines, hotStandby: parsed.data.hotStandby };
      return null;
    } catch (error) {
      return error instanceof SyntaxError
        ? "the settings file is not valid JSON"
        : `cannot read the settings: ${describeError(error)}`;
    }
  }

  get(): Settings {
    return { ...this.current };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    return this.mutex.run(async () => {
      const next: Settings = { ...this.current, ...patch };
      await writeJsonFile(this.path, { version: 1, ...next });
      this.current = next;
      return { ...next };
    });
  }
}
