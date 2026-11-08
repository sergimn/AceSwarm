export interface PlaylistSegment {
  duration: number;
  uri: string;
}

export interface ParsedPlaylist {
  mediaSequence: number;
  segments: PlaylistSegment[];
}

/** Parses the media playlist ffmpeg writes (only the tags it emits). */
export function parseMediaPlaylist(text: string): ParsedPlaylist {
  const segments: PlaylistSegment[] = [];
  let mediaSequence = 0;
  let duration: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
    } else if (line.startsWith("#EXTINF:")) {
      duration = Number.parseFloat(line.slice("#EXTINF:".length));
    } else if (line.length > 0 && !line.startsWith("#") && duration !== undefined) {
      segments.push({ duration, uri: line });
      duration = undefined;
    }
  }
  return { mediaSequence, segments };
}

interface VirtualSegment {
  uri: string;
  duration: number;
  discontinuity: boolean;
  /** When it was added: a segment's video is about as old as that. */
  addedAt: number;
}

export function segmentIndex(uri: string): number {
  const match = /(\d+)\.ts$/.exec(uri);
  return match?.[1] === undefined ? -1 : Number.parseInt(match[1], 10);
}

/**
 * A live playlist that survives source changes. Each ffmpeg run ("generation") writes its own
 * playlist; this one stitches them together with `#EXT-X-DISCONTINUITY` markers and keeps the
 * media sequence increasing, so players keep going instead of failing when ffmpeg restarts or
 * the stream moves to another engine.
 */
export class VirtualPlaylist {
  private readonly windowSize: number;
  private segments: VirtualSegment[] = [];
  private mediaSequence = 0;
  private discontinuitySequence = 0;
  private lastGeneration: number | undefined;
  private lastIndex = -1;

  constructor(windowSize: number) {
    this.windowSize = windowSize;
  }

  get length(): number {
    return this.segments.length;
  }

  /**
   * Adds the segments a generation currently lists. Segments already added are skipped, and
   * an older generation can never append after a newer one.
   */
  append(generation: number, segments: PlaylistSegment[], uriPrefix: string, now = Date.now()): void {
    if (this.lastGeneration !== undefined && generation < this.lastGeneration) {
      return;
    }
    for (const segment of segments) {
      const index = segmentIndex(segment.uri);
      if (generation === this.lastGeneration && index <= this.lastIndex) {
        continue;
      }
      const discontinuity = this.lastGeneration !== undefined && generation !== this.lastGeneration;
      this.segments.push({
        uri: `${uriPrefix}${segment.uri}`,
        duration: segment.duration,
        discontinuity,
        addedAt: now,
      });
      this.lastGeneration = generation;
      this.lastIndex = index;
    }
    while (this.segments.length > this.windowSize) {
      this.dropHead();
    }
  }

  /**
   * Drops the segments added before `before`: when no new video came for that long, what is left
   * is old, and a player that opens the stream now must not start on it. The media sequence keeps
   * counting, so players that keep polling go on with the next segments.
   */
  expire(before: number): void {
    while (this.segments[0] !== undefined && this.segments[0].addedAt < before) {
      this.dropHead();
    }
  }

  private dropHead(): void {
    const dropped = this.segments.shift();
    if (dropped === undefined) {
      return;
    }
    this.mediaSequence += 1;
    if (dropped.discontinuity) {
      // It was the head with its own tag (added to an empty playlist): the tag leaves with it.
      this.discontinuitySequence += 1;
    }
    if (this.segments[0]?.discontinuity !== true) {
      return;
    }
    // The tag at the new head is dropped from the output (see render), so count it here.
    this.discontinuitySequence += 1;
    this.segments[0] = { ...this.segments[0], discontinuity: false };
  }

  render(): string | undefined {
    if (this.segments.length === 0) {
      return undefined;
    }
    const target = Math.max(1, ...this.segments.map((segment) => Math.ceil(segment.duration)));
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      `#EXT-X-TARGETDURATION:${String(target)}`,
      `#EXT-X-MEDIA-SEQUENCE:${String(this.mediaSequence)}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${String(this.discontinuitySequence)}`,
      "#EXT-X-INDEPENDENT-SEGMENTS",
    ];
    for (const segment of this.segments) {
      if (segment.discontinuity) {
        lines.push("#EXT-X-DISCONTINUITY");
      }
      lines.push(`#EXTINF:${segment.duration.toFixed(3)},`, segment.uri);
    }
    return `${lines.join("\n")}\n`;
  }
}
