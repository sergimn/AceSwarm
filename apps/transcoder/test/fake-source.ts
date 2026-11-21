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
  /**
   * Tells the owner that the stream's layout changed and the reader's run reads on (see `PidMoves`):
   * the streams moved to other PIDs, or the ones it reads stayed where they were (`inPlace`).
   */
  move: (layout: Layout, inPlace?: boolean) => void;
  /** Ends the source, as when the engine closes the stream. */
  end: (reason: string) => void;
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
          const next = request.onLayout({ layout, previous: source.told, delivered });
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
        move: (layout, inPlace = false) => {
          const previous = source.told;
          source.told = layout;
          if (previous !== undefined) {
            request.onMove?.({ layout, previous, inPlace });
          }
        },
        end: (reason) => {
          request.onEnd({ reason });
        },
      };
      opened.push(source);
      return {
        stop: () => {
          source.stopped = true;
        },
      };
    },
  };
}

/**
 * A layout with one program: its video on `videoPid` with stream type `type`, and audio of
 * `audioType` (AAC unless said) next to it. The program's table is on `pmtPid`.
 */
export function layoutOf(videoPid: number, type = 0x1b, pmtPid = 4096, audioType = 0x0f): Layout {
  const streams = [
    { pid: videoPid, type, descriptors: new Uint8Array(0) },
    { pid: videoPid + 1, type: audioType, descriptors: new Uint8Array(0) },
  ];
  const key = `1@${String(pmtPid)}[${streams.map((entry) => `${String(entry.pid)}:${String(entry.type)}:`).join(",")}]`;
  return { programs: [{ number: 1, pmtPid, pcrPid: videoPid, streams }], key };
}
