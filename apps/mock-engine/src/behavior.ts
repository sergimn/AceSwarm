/**
 * The mock engine picks a behaviour from the content ID prefix, so tests can ask for a broken or
 * flaky stream just by choosing its ID.
 */
export type Behavior =
  /** Plays forever. */
  | "normal"
  /** Content never loads: `getstream` fails like a real engine with no peers. */
  | "dead"
  /** Plays, then stops delivering data (the HTTP response stays open, like a stalled swarm). */
  | "stall"
  /** Only loads and plays while a VPN-only mock peer answers, i.e. through a WireGuard path. */
  | "vpn-only"
  /** Plays MPEG-2 video, which the transcoder has to re-encode for browsers. */
  | "mpeg2";

const PREFIXES: readonly (readonly [string, Behavior])[] = [
  ["dead", "dead"],
  ["0bad", "stall"],
  ["beef", "vpn-only"],
  ["ec0d", "mpeg2"],
];

export function behaviorFor(contentId: string): Behavior {
  const id = contentId.toLowerCase();
  return PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1] ?? "normal";
}

/** A stable hue per content ID so tiles of different streams look different. */
export function hueFor(contentId: string): number {
  let hash = 0;
  for (const char of contentId) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  }
  return hash;
}

export interface SourcePlan {
  size: string;
  fps: number;
  hue: number;
  codec: "h264" | "mpeg2";
}

/** ffmpeg arguments for a synthetic, real-time MPEG-TS stream with a test pattern and a tone. */
export function buildSourceArgs(plan: SourcePlan): string[] {
  const video =
    plan.codec === "h264"
      ? ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-b:v", "1500k"]
      : ["-c:v", "mpeg2video", "-b:v", "2500k"];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-re",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${plan.size}:rate=${String(plan.fps)}`,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-vf",
    `hue=h=${String(plan.hue)}`,
    ...video,
    "-g",
    String(plan.fps * 2),
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-f",
    "mpegts",
    "pipe:1",
  ];
}
