import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AceIdKind } from "@aceswarm/shared/ace-id";
import { z } from "zod";
import { Mutex, readJsonFile, writeJsonFile } from "./json-file.ts";

const streamSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{6,32}$/),
  /** Acestream content ID or infohash. */
  aceId: z.string().regex(/^[0-9a-f]{40}$/),
  /** What `aceId` is, once known (the engine accepted it as that kind). */
  aceIdKind: z.enum(["content-id", "infohash"]).nullable().default(null),
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  createdAt: z.string(),
  /** Last network path the stream used; kept so the sticky choice survives restarts. */
  path: z.string().nullable().default(null),
  /**
   * The container name of the stream's own engine it plays from; null on a shared engine. After a
   * restart the controller takes that one over, rather than a newer engine a failed move left.
   */
  ownEngine: z.string().nullable().default(null),
});

const fileSchema = z.object({
  version: z.literal(1),
  streams: z.array(streamSchema),
});

export type StreamConfig = z.infer<typeof streamSchema>;

export class DuplicateStreamError extends Error {
  constructor(aceId: string) {
    super(`stream ${aceId} is already in the list`);
    this.name = "DuplicateStreamError";
  }
}

export interface NewStream {
  aceId: string;
  aceIdKind?: AceIdKind | null;
  name?: string | undefined;
}

export type StreamPatch = Partial<Pick<StreamConfig, "name" | "enabled" | "path" | "aceIdKind" | "ownEngine">>;

/**
 * Persists the list of streams in `<data>/streams.json`. The file is the source of truth, so
 * additions and removals survive restarts of every service.
 */
export class StreamStore {
  private readonly path: string;
  private readonly mutex = new Mutex();
  private streams: StreamConfig[] = [];

  constructor(dataDir: string) {
    this.path = join(dataDir, "streams.json");
  }

  async load(): Promise<void> {
    const raw = await readJsonFile(this.path);
    this.streams = raw === undefined ? [] : fileSchema.parse(raw).streams;
  }

  list(): StreamConfig[] {
    return this.streams.map((stream) => ({ ...stream }));
  }

  get(id: string): StreamConfig | undefined {
    const stream = this.streams.find((candidate) => candidate.id === id);
    return stream === undefined ? undefined : { ...stream };
  }

  async add(input: NewStream): Promise<StreamConfig> {
    return this.mutex.run(async () => {
      if (this.streams.some((stream) => stream.aceId === input.aceId)) {
        throw new DuplicateStreamError(input.aceId);
      }
      const name = input.name?.trim();
      const stream: StreamConfig = {
        id: randomBytes(5).toString("hex"),
        aceId: input.aceId,
        aceIdKind: input.aceIdKind ?? null,
        name: name === undefined || name.length === 0 ? `Stream ${input.aceId.slice(0, 6)}` : name,
        enabled: true,
        createdAt: new Date().toISOString(),
        path: null,
        ownEngine: null,
      };
      await this.persist([...this.streams, stream]);
      return { ...stream };
    });
  }

  async update(id: string, patch: StreamPatch): Promise<StreamConfig | undefined> {
    return this.mutex.run(async () => {
      const index = this.streams.findIndex((stream) => stream.id === id);
      const current = this.streams[index];
      if (current === undefined) {
        return;
      }
      const updated = streamSchema.parse({ ...current, ...patch });
      const next = [...this.streams];
      next[index] = updated;
      await this.persist(next);
      return { ...updated };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const next = this.streams.filter((stream) => stream.id !== id);
      if (next.length === this.streams.length) {
        return false;
      }
      await this.persist(next);
      return true;
    });
  }

  private async persist(streams: StreamConfig[]): Promise<void> {
    await writeJsonFile(this.path, { version: 1, streams });
    this.streams = streams;
  }
}
