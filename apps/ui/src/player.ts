import type { Snapshot, StreamView } from "@aceswarm/shared/api-types";
import Hls from "hls.js/light";
import { api } from "./api.ts";
import { errorMessage, h, icon, toast } from "./dom.ts";
import { formatFreshness, formatPeers, formatSpeed, formatStandbys, pathLabel, STATE_LABELS } from "./format.ts";
import type { Navigator } from "./navigation.ts";
import type { WatchReporter } from "./watch.ts";

const OVERLAY_MS = 4000;

/** Full screen playback of the full-quality HLS output, with sound. */
export class Player {
  private readonly root: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly title: HTMLElement;
  private readonly details: HTMLElement;
  /** Shown instead of the picture while the stream waits for its broadcast (stale source). */
  private readonly waiting: HTMLElement;
  private readonly waitingReason: HTMLElement;
  private readonly navigator: Navigator;
  private readonly watch: WatchReporter;
  private readonly backButton: HTMLButtonElement;
  private hls: Hls | undefined;
  private streamId: string | undefined;
  private overlayTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(navigator: Navigator, watch: WatchReporter) {
    this.navigator = navigator;
    this.watch = watch;
    this.video = h("video", { className: "player-video", attrs: { playsinline: true, autoplay: true } });
    this.title = h("h2", { className: "player-title" });
    this.details = h("p", { className: "player-details" });
    this.waitingReason = h("p", { className: "player-waiting-reason" });
    this.waiting = h("div", { className: "player-waiting", attrs: { hidden: true, role: "status" } }, [
      h("p", { className: "player-waiting-title", text: "Waiting for the live broadcast" }),
      this.waitingReason,
    ]);
    const backButton = h("button", { className: "button", attrs: { type: "button" } }, [icon("back"), "Back"]);
    this.backButton = backButton;
    backButton.addEventListener("click", () => {
      this.navigator.back();
    });
    const restartButton = h("button", { className: "button", attrs: { type: "button" } }, [
      icon("refresh"),
      "Restart stream",
    ]);
    restartButton.addEventListener("click", () => {
      this.restart();
    });
    this.root = h("div", { className: "player", attrs: { hidden: true, role: "dialog", "aria-label": "Player" } }, [
      this.video,
      this.waiting,
      h("div", { className: "player-overlay" }, [
        h("div", { className: "player-info" }, [this.title, this.details]),
        h("div", { className: "player-actions" }, [backButton, restartButton]),
      ]),
    ]);
    this.root.addEventListener("pointermove", () => {
      this.showOverlay();
    });
    document.body.append(this.root);
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement === null && this.streamId !== undefined) {
        this.navigator.back();
      }
    });
  }

  get openStreamId(): string | undefined {
    return this.streamId;
  }

  open(stream: StreamView): void {
    this.streamId = stream.id;
    this.watch.show(stream.id);
    this.root.hidden = false;
    this.attach(stream.hls.full);
    this.navigator.open({
      root: this.root,
      close: () => {
        this.close();
      },
      onKey: (event) => this.onKey(event),
    });
    if (document.fullscreenEnabled) {
      this.root.requestFullscreen().catch(() => {
        // Not allowed (for example without a user gesture): the player still covers the window.
      });
    }
    this.backButton.focus();
    this.showOverlay();
  }

  update(snapshot: Snapshot): void {
    if (this.streamId === undefined) {
      return;
    }
    const stream = snapshot.streams.find((candidate) => candidate.id === this.streamId);
    if (stream === undefined) {
      this.navigator.back();
      return;
    }
    this.title.textContent = stream.name;
    // Its broadcast sends nothing new: the last picture would be old, so it doesn't show.
    const waiting = stream.state === "stale-source";
    this.root.classList.toggle("waiting-for-source", waiting);
    this.waiting.hidden = !waiting;
    this.waitingReason.textContent = waiting ? (stream.message ?? "") : "";
    this.details.textContent = [
      STATE_LABELS[stream.state],
      `Last frame: ${formatFreshness(stream.lastFrameAt, Date.now())}`,
      `Peers: ${formatPeers(stream.peers)}`,
      formatSpeed(stream.downloadKBps),
      pathLabel(stream.path, snapshot.paths),
      ...(stream.standbys.length > 0 ? [`Standby: ${formatStandbys(stream.standbys, snapshot.paths)}`] : []),
    ].join("  ·  ");
  }

  private attach(url: string): void {
    if (Hls.isSupported()) {
      const hls = new Hls({ liveSyncDurationCount: 3, backBufferLength: 30 });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
          return;
        }
        // Live streams recover by reloading; the controller keeps the playlist continuous.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          setTimeout(() => {
            if (this.hls === hls) {
              hls.loadSource(url);
            }
          }, 2000);
        }
      });
      hls.loadSource(url);
      hls.attachMedia(this.video);
      this.hls = hls;
    } else {
      this.video.src = url;
    }
    this.video.play().catch(() => {
      this.video.muted = true;
      void this.video.play().catch(() => undefined);
    });
  }

  private close(): void {
    this.streamId = undefined;
    this.watch.show(null);
    this.hls?.destroy();
    this.hls = undefined;
    this.video.removeAttribute("src");
    this.video.load();
    this.root.hidden = true;
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }

  private onKey(event: KeyboardEvent): boolean {
    const hidden = !this.root.classList.contains("show-overlay");
    this.showOverlay();
    // While the overlay is hidden, the first key only reveals it (so Enter cannot restart by accident).
    return hidden && (event.key === "Enter" || event.key.startsWith("Arrow"));
  }

  private showOverlay(): void {
    this.root.classList.add("show-overlay");
    clearTimeout(this.overlayTimer);
    this.overlayTimer = setTimeout(() => {
      this.root.classList.remove("show-overlay");
    }, OVERLAY_MS);
  }

  private restart(): void {
    const id = this.streamId;
    if (id === undefined) {
      return;
    }
    api
      .restartStream(id)
      .then(() => {
        toast("Restarting the stream");
      })
      .catch((error: unknown) => {
        toast(errorMessage(error), "error");
      });
  }
}
