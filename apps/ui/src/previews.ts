import Hls, { type HlsConfig } from "hls.js/light";

export type PreviewMode = "video" | "thumbnails";

const PREVIEW_CONFIG: Partial<HlsConfig> = {
  enableWorker: true,
  liveSyncDurationCount: 2,
  maxBufferLength: 8,
  maxMaxBufferLength: 12,
  backBufferLength: 0,
  capLevelToPlayerSize: true,
};

const RETRY_MS = 5000;

interface Entry {
  url: string;
  wanted: boolean;
  visible: boolean;
  player: Hls | "native" | undefined;
  retryAt: number;
}

/**
 * Plays the low-resolution tile previews. Only tiles on screen play, up to a limit, so a TV or a
 * small device is not asked to decode every stream at once. In "thumbnails" mode tiles only show
 * the periodically refreshed still image.
 */
export class PreviewManager {
  private readonly entries = new Map<HTMLVideoElement, Entry>();
  private readonly observer: IntersectionObserver;
  private readonly maxActive: number;
  private mode: PreviewMode;

  constructor(mode: PreviewMode, maxActive: number) {
    this.mode = mode;
    this.maxActive = maxActive;
    this.observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const entry = this.entries.get(record.target as HTMLVideoElement);
          if (entry !== undefined) {
            entry.visible = record.isIntersecting;
          }
        }
        this.reconcile();
      },
      { threshold: 0.2 },
    );
    setInterval(() => {
      this.reconcile();
    }, RETRY_MS);
  }

  get currentMode(): PreviewMode {
    return this.mode;
  }

  setMode(mode: PreviewMode): void {
    this.mode = mode;
    this.reconcile();
  }

  register(video: HTMLVideoElement, url: string): void {
    video.muted = true;
    video.playsInline = true;
    this.entries.set(video, { url, wanted: false, visible: false, player: undefined, retryAt: 0 });
    this.observer.observe(video);
  }

  /** Whether the stream currently has something worth playing. */
  setWanted(video: HTMLVideoElement, wanted: boolean): void {
    const entry = this.entries.get(video);
    if (entry === undefined || entry.wanted === wanted) {
      return;
    }

    entry.wanted = wanted;
    this.reconcile();
  }

  unregister(video: HTMLVideoElement): void {
    const entry = this.entries.get(video);
    if (entry !== undefined) {
      this.stop(video, entry);
      this.entries.delete(video);
    }
    this.observer.unobserve(video);
  }

  private reconcile(): void {
    let budget = this.mode === "video" ? this.maxActive : 0;
    const now = Date.now();
    for (const [video, entry] of this.entries) {
      const shouldPlay = entry.wanted && entry.visible && budget > 0;
      if (shouldPlay) {
        budget -= 1;
      }
      if (shouldPlay && entry.player === undefined && now >= entry.retryAt) {
        this.start(video, entry);
      } else if (!shouldPlay && entry.player !== undefined) {
        this.stop(video, entry);
      }
    }
  }

  private start(video: HTMLVideoElement, entry: Entry): void {
    if (Hls.isSupported()) {
      const hls = new Hls(PREVIEW_CONFIG);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
          return;
        }

        this.stop(video, entry);
        entry.retryAt = Date.now() + RETRY_MS;
      });
      hls.loadSource(entry.url);
      hls.attachMedia(video);
      entry.player = hls;
    } else if (video.canPlayType("application/vnd.apple.mpegurl") === "") {
      return;
    } else {
      video.src = entry.url;
      entry.player = "native";
    }
    video.play().catch(() => {
      // Autoplay can be refused (for example while the page is hidden); the next pass retries.
    });
  }

  private stop(video: HTMLVideoElement, entry: Entry): void {
    if (entry.player instanceof Hls) {
      entry.player.destroy();
    }
    entry.player = undefined;
    video.removeAttribute("src");
    video.load();
  }
}
