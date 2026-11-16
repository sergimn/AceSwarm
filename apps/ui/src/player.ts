import type { Snapshot, StreamView } from "@aceswarm/shared/api-types";
import Hls from "hls.js/light";
import { api } from "./api.ts";
import { startClock } from "./clock.ts";
import { errorMessage, h, icon, toast } from "./dom.ts";
import {
  formatFreshness,
  formatPeers,
  formatSpeed,
  formatStandbys,
  pathLabel,
  shownState,
  STATE_LABELS,
} from "./format.ts";
import { OUTAGE_TOLERANT_LOADING } from "./hls-config.ts";
import type { Navigator } from "./navigation.ts";
import type { WatchReporter } from "./watch.ts";

const OVERLAY_MS = 4000;

/** Full screen playback of the full-quality HLS output, with sound. */
export class Player {
  private readonly root: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly title: HTMLElement;
  private readonly details: HTMLElement;
  /**
   * Shown instead of the picture while there is none to show: the stream waits for its broadcast
   * (stale source), or it is disabled.
   */
  private readonly waiting: HTMLElement;
  private readonly waitingTitle: HTMLElement;
  private readonly waitingReason: HTMLElement;
  /** The Restart button's label: it enables the stream while that is disabled, since it can't restart. */
  private readonly restartLabel: Text;
  private disabled = false;
  /** Whether it plays the stream's output and counts as its viewer: not while the stream is disabled. */
  private following = false;
  private readonly navigator: Navigator;
  private readonly watch: WatchReporter;
  private readonly backButton: HTMLButtonElement;
  /** Shown beside the buttons only in full screen, where the overlay appears with the cursor. */
  private readonly clock: HTMLElement;
  private hls: Hls | undefined;
  private streamId: string | undefined;
  private overlayTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(navigator: Navigator, watch: WatchReporter) {
    this.navigator = navigator;
    this.watch = watch;
    this.video = h("video", { className: "player-video", attrs: { playsinline: true, autoplay: true } });
    this.title = h("h2", { className: "player-title" });
    this.details = h("p", { className: "player-details" });
    this.waitingTitle = h("p", { className: "player-waiting-title" });
    this.waitingReason = h("p", { className: "player-waiting-reason" });
    this.waiting = h("div", { className: "player-waiting", attrs: { hidden: true, role: "status" } }, [
      this.waitingTitle,
      this.waitingReason,
    ]);
    const backButton = h("button", { className: "button", attrs: { type: "button" } }, [icon("back"), "Back"]);
    this.backButton = backButton;
    backButton.addEventListener("click", () => {
      this.navigator.back();
    });
    this.restartLabel = document.createTextNode("Restart stream");
    const restartButton = h("button", { className: "button", attrs: { type: "button" } }, [
      icon("refresh"),
      this.restartLabel,
    ]);
    restartButton.addEventListener("click", () => {
      this.restart();
    });
    this.clock = h("time", { className: "player-clock", attrs: { hidden: true } });
    startClock(this.clock);
    const info = h("div", { className: "player-info" }, [this.title, this.details]);
    const top = h("div", { className: "player-top" }, [info, this.clock]);
    const actions = h("div", { className: "player-actions" }, [backButton, restartButton]);
    this.root = h("div", { className: "player", attrs: { hidden: true, role: "dialog", "aria-label": "Player" } }, [
      this.video,
      this.waiting,
      h("div", { className: "player-overlay" }, [top, actions]),
    ]);
    this.root.addEventListener("pointermove", () => {
      this.showOverlay();
    });
    document.body.append(this.root);
    document.addEventListener("fullscreenchange", () => {
      this.clock.hidden = document.fullscreenElement !== this.root;
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
    this.root.hidden = false;
    this.follow(stream);
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
    this.follow(stream);
    this.title.textContent = stream.name;
    const state = shownState(stream);
    const disabled = state === "stopped";
    // Its broadcast sends nothing new: the last picture would be old, so it doesn't show.
    const waiting = state === "stale-source";
    this.disabled = disabled;
    this.root.classList.toggle("waiting-for-source", waiting);
    this.root.classList.toggle("disabled", disabled);
    this.waiting.hidden = !waiting && !disabled;
    this.waitingTitle.textContent = disabled ? "This stream is disabled" : "Waiting for the live broadcast";
    this.waitingReason.textContent = disabled ? "Enable it to watch it." : (stream.message ?? "");
    this.restartLabel.data = disabled ? "Enable stream" : "Restart stream";
    const last = `Last frame: ${formatFreshness(stream.lastFrameAt, Date.now(), state === "playing")}`;
    // A disabled stream has no engine: no peers, no speed, no path.
    const running = disabled
      ? []
      : [
          `Peers: ${formatPeers(stream.peers, state, stream.engine?.shared === true)}`,
          formatSpeed(stream.downloadKBps),
          pathLabel(stream.path, snapshot.paths),
          ...(stream.standbys.length > 0 ? [`Standby: ${formatStandbys(stream.standbys, snapshot.paths)}`] : []),
        ];
    this.details.textContent = [STATE_LABELS[state], last, ...running].join("  ·  ");
  }

  /**
   * Plays the stream and counts as its viewer while it is enabled. A disabled stream has no output
   * to ask for, and nobody watches it; once it is enabled, the player starts by itself.
   */
  private follow(stream: StreamView): void {
    if (stream.enabled === this.following) {
      return;
    }
    this.following = stream.enabled;
    if (stream.enabled) {
      this.watch.show(stream.id);
      this.attach(stream.hls.full);
    } else {
      this.watch.show(null);
      this.detach();
    }
  }

  private attach(url: string): void {
    if (Hls.isSupported()) {
      const hls = new Hls({ ...OUTAGE_TOLERANT_LOADING, liveSyncDurationCount: 3, backBufferLength: 30 });
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

  private detach(): void {
    this.hls?.destroy();
    this.hls = undefined;
    this.video.removeAttribute("src");
    this.video.load();
  }

  private close(): void {
    this.streamId = undefined;
    this.following = false;
    this.watch.show(null);
    this.detach();
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
    const done = this.disabled
      ? api.updateStream(id, { enabled: true }).then(() => "Enabling the stream")
      : api.restartStream(id).then(() => "Restarting the stream");
    done
      .then((message) => {
        toast(message);
      })
      .catch((error: unknown) => {
        toast(errorMessage(error), "error");
      });
  }
}
