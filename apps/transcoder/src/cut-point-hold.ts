import { packetParts, pesStart } from "./es-headers.ts";
import { cutPointOf, type CutPoint } from "./h264-cut-points.ts";
import { PACKET_BYTES } from "./ts-packets.ts";
import { videoCodecOf, type Layout } from "./ts-tables.ts";

/** How much of an access unit's start is read for its first slice: what comes before it is a few hundred bytes. */
const HEAD_BYTES = 4096;
/** How many packets are held back for one access unit at most: its own, and those of other PIDs between them. */
const MAX_HELD_PACKETS = 64;

/**
 * An access unit of the video that was held back (see `CutPointHold`), once it tells: whether
 * ffmpeg can cut a copy of the video at it (see `cutPointOf`), its PES's time stamp, and its
 * packets, with those of other PIDs that came meanwhile, as they came.
 */
export interface HeldUnit {
  point: CutPoint;
  pts: number | undefined;
  packets: Uint8Array[];
}

/** The PID of the layout's video, when that is its one video stream and H.264. */
function h264Pid(layout: Layout): number | undefined {
  const videos = layout.programs
    .flatMap((program) => program.streams)
    .filter((entry) => videoCodecOf(entry) !== undefined);
  const [only] = videos;
  return videos.length === 1 && only !== undefined && videoCodecOf(only) === "h264" ? only.pid : undefined;
}

/**
 * Holds back the start of each access unit of a run's H.264 video until it shows whether ffmpeg
 * can cut a copy of the video at it (see `cutPointOf`), so that a run that copies the video can begin
 * right at that unit (see `SourceRequest.cutPoints`). The packets of other PIDs that come meanwhile
 * are held with it, so that the stream keeps its order. That is a packet or a few: a unit's first
 * slice follows its parameter sets and SEI messages.
 */
export class CutPointHold {
  private layout: Layout | undefined;
  private pid: number | undefined;
  private held: Uint8Array[] = [];
  private readonly head = new Uint8Array(HEAD_BYTES);
  /** How much of the held unit's start is in `head`. */
  private length = 0;
  private pts: number | undefined;

  /**
   * The stream's next packet (the 188 bytes at `at`), on `pid`, for a run that reads `layout`. At
   * the start of each access unit of its video, `watching` tells whether to look at that unit.
   * Returns "pass" for a packet that goes on as it is, "held" for one that is held back, or the
   * held unit with this packet once it tells (see `HeldUnit`).
   */
  packet(
    data: Uint8Array,
    at: number,
    pid: number,
    layout: Layout,
    watching: () => boolean,
  ): "pass" | "held" | HeldUnit {
    if (layout !== this.layout) {
      this.layout = layout;
      this.pid = h264Pid(layout);
    }
    const holding = this.held.length > 0;
    if (!holding && pid !== this.pid) {
      return "pass";
    }
    const parts = pid === this.pid ? packetParts(data, at) : undefined;
    const pes = parts === undefined ? undefined : pesStart(data, at, parts);
    if (!holding) {
      if (pes === undefined || !watching()) {
        return "pass";
      }
      this.pts = pes.pts;
    }
    this.held.push(Uint8Array.from(data.subarray(at, at + PACKET_BYTES)));
    if (parts === undefined) {
      return this.told(undefined);
    }
    if (holding && parts.unitStart) {
      // The unit ended before a slice: none that a cut could begin at. The one that starts here
      // goes with it, unlooked at.
      return this.done("none");
    }
    this.read(data, at, pes?.dataAt ?? parts.payloadAt);
    return this.told(cutPointOf(this.head.subarray(0, this.length)));
  }

  /** Adds the payload of the packet at `at`, from `from` on, to the start of the held unit. */
  private read(data: Uint8Array, at: number, from: number): void {
    if (from < 0) {
      return;
    }
    const take = Math.min(at + PACKET_BYTES - from, HEAD_BYTES - this.length);
    this.head.set(data.subarray(from, from + take), this.length);
    this.length += take;
  }

  /** The held unit once it tells (`point`), or once more was held than a unit's start takes; "held" until then. */
  private told(point: CutPoint | undefined): "held" | HeldUnit {
    if (point !== undefined) {
      return this.done(point);
    }
    return this.length < HEAD_BYTES && this.held.length < MAX_HELD_PACKETS ? "held" : this.done("none");
  }

  /** Lets go of what is held, as no unit to cut at: the stream changes, or ends. Returns its packets, as they came. */
  release(): Uint8Array[] {
    return this.held.length === 0 ? [] : this.done("none").packets;
  }

  private done(point: CutPoint): HeldUnit {
    const unit = { point, pts: this.pts, packets: this.held };
    this.held = [];
    this.length = 0;
    this.pts = undefined;
    return unit;
  }
}
