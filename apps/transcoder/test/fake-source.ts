import type { Layout } from "../src/ts-tables.ts";
import type { OpenSource, Sink, SourceRequest } from "../src/source-reader.ts";

/** A source a test drives by hand: nothing comes of it, as with an engine still looking for peers. */
export interface FakeSource {
  request: SourceRequest;
  stopped: boolean;
  /** The sink the reader feeds now: the one it was opened with, or the last one `layout` got back. */
  sink: Sink;
  /** The layout it told about last. */
  told: Layout | undefined;
  /**
   * Tells the owner the stream's layout, as the reader does when the first tables came or they
   * changed. Returns whether the owner handed over another sink.
   */
  layout: (layout: Layout, delivered?: boolean) => boolean;
  /** Ends the source, as when the engine closes the stream. */
  end: (reason: string, delivered?: boolean) => void;
}

/** Stands in for `readSource`, and keeps every source opened, in order. */
export function fakeSources(): { open: OpenSource; opened: FakeSource[] } {
  const opened: FakeSource[] = [];
  return {
    opened,
    open: (request) => {
      const source: FakeSource = {
        request,
        stopped: false,
        sink: request.sink,
        told: undefined,
        layout: (layout, delivered = source.told !== undefined) => {
          const next = request.onLayout({ layout, previous: source.told, delivered, quietMs: 0 });
          source.told = layout;
          if (next === undefined || next === source.sink) {
            return false;
          }
          if (delivered) {
            source.sink.end();
          }
          source.sink = next;
          return true;
        },
        end: (reason, delivered = source.told !== undefined) => {
          request.onEnd({ reason, delivered });
        },
      };
      opened.push(source);
      return {
        stop: () => {
          source.stopped = true;
        },
        status: () => ({ bytes: 0, lastDataAt: undefined, layout: source.told }),
      };
    },
  };
}

/** A layout with one program: its video on `videoPid` with stream type `type`, and AAC audio next to it. */
export function layoutOf(videoPid: number, type = 0x1b): Layout {
  const streams = [
    { pid: videoPid, type, descriptors: new Uint8Array(0) },
    { pid: videoPid + 1, type: 0x0f, descriptors: new Uint8Array(0) },
  ];
  const key = `1@4096[${streams.map((entry) => `${String(entry.pid)}:${String(entry.type)}:`).join(",")}]`;
  return { programs: [{ number: 1, pmtPid: 4096, pcrPid: videoPid, streams }], key };
}
