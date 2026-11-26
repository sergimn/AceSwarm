import type { Snapshot, StreamView } from "@aceswarm/shared/api-types";
import Hls from "hls.js/light";
import { api } from "./api.ts";
import { startClock } from "./clock.ts";
import { errorMessage, h, icon, setText, toast } from "./dom.ts";
import { absoluteUrl, copyText, handOffFor, handOffMessage, openExternally, type HandOff } from "./external-player.ts";
import { OUTAGE_TOLERANT_LOADING } from "./hls-config.ts";
import { staleNotice, type PageTime } from "./liveness.ts";
import type { Navigator } from "./navigation.ts";
import { pictureRect, PLAYER_STATS, playerStats, statsTop, waitingRoom, type PlayerStatKey } from "./player-stats.ts";
import type { WatchReporter } from "./watch.ts";

const OVERLAY_MS = 4000;
/** The least room left between the stats window and the title above it, or the buttons below it. */
const STATS_GAP = 12;

/** The custom properties that place the message that says why there is no picture. */
const WAITING_SIDES = ["top", "bottom", "left"] as const;

/** Full screen playback of the full-quality HLS output, with sound. */
export class Player {
  private readonly root: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly title: HTMLElement;
  /**
   * The live stats, one to a line, in a window over the picture: it sits at the picture's left,
   * a quarter of the way down, whatever the stream's shape (see `placeStats`).
   */
  private readonly stats: HTMLElement;
  private readonly statRows: { key: PlayerStatKey; row: HTMLElement; value: HTMLElement }[];
  /** Above the stats while the page hears nothing from the controller: they are old. */
  private readonly connection: HTMLElement;
  /**
   * Shown instead of the picture while there is none to show: the stream waits for its broadcast
   * (stale source), it is disabled, or it was handed to an external player.
   */
  private readonly waiting: HTMLElement;
  private readonly waitingTitle: HTMLElement;
  private readonly waitingReason: HTMLElement;
  /**
   * An unseen copy of that message that always stays in the middle of the screen, measured to see
   * whether the stats window would cover it there. Measuring the message itself would find it
   * where it was moved to, and moving it there and back to measure it would cut its slide short.
   */
  private readonly waitingProbe: HTMLElement;
  private readonly probeTitle: HTMLElement;
  private readonly probeReason: HTMLElement;
  /** The Restart button's label: it enables the stream while that is disabled, since it can't restart. */
  private readonly restartLabel: Text;
  private disabled = false;
  /** While the stream waits for its broadcast: what the controller says about it. */
  private staleSource: string | undefined;
  /**
   * While the stream plays in an external player it was handed to: how it was handed over. The page
   * then shows no video of its own (see `handOver`).
   */
  private handOff: HandOff | undefined;
  /** Hands the stream to an external player; in its place while it is handed over, `resumeButton`. */
  private readonly externalButton: HTMLButtonElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  /** Whether the page hears nothing from the controller: the overlay then stays up to say so. */
  private stale = false;
  /**
   * Whether it plays the stream's output and counts as its viewer: not while the stream is disabled,
   * or handed to an external player.
   */
  private following = false;
  private readonly navigator: Navigator;
  private readonly watch: WatchReporter;
  private readonly backButton: HTMLButtonElement;
  /**
   * The browser's time, with the overlay. The player covers the whole window, top bar and its clock
   * included, whether or not the browser could enter full screen.
   */
  private readonly clock: HTMLElement;
  /** The title and the clock, and the buttons (Back, Restart...): the stats window stays between them. */
  private readonly topBar: HTMLElement;
  private readonly actions: HTMLElement;
  private hls: Hls | undefined;
  private streamId: string | undefined;
  /** The stream as the page last heard of it. */
  private stream: StreamView | undefined;
  private overlayTimer: ReturnType<typeof setTimeout> | undefined;
  /** The player's request to go full screen, until the browser has answered it. */
  private fullscreenRequest: Promise<void> | undefined;

  constructor(navigator: Navigator, watch: WatchReporter) {
    this.navigator = navigator;
    this.watch = watch;
    this.video = h("video", { className: "player-video", attrs: { playsinline: true, autoplay: true } });
    this.title = h("h2", { className: "player-title" });
    this.statRows = (Object.keys(PLAYER_STATS) as PlayerStatKey[]).map((key) => {
      const value = h("dd");
      const row = h("div", { className: "player-stat", attrs: { "data-stat": key } }, [
        h("dt", { text: PLAYER_STATS[key] }),
        value,
      ]);
      return { key, row, value };
    });
    this.connection = h("p", { className: "player-connection", attrs: { hidden: true } });
    // The line that says the stats are old comes first: on a small screen, the window's last
    // lines can end up behind Back and Restart.
    this.stats = h("div", { className: "player-stats" }, [
      this.connection,
      h(
        "dl",
        {},
        this.statRows.map(({ row }) => row),
      ),
    ]);
    this.waitingTitle = h("p", { className: "player-waiting-title" });
    this.waitingReason = h("p", { className: "player-waiting-reason" });
    this.waiting = h("div", { className: "player-waiting", attrs: { hidden: true, role: "status" } }, [
      this.waitingTitle,
      this.waitingReason,
    ]);
    this.probeTitle = h("p", { className: "player-waiting-title" });
    this.probeReason = h("p", { className: "player-waiting-reason" });
    this.waitingProbe = h(
      "div",
      { className: "player-waiting-probe", attrs: { hidden: true, "aria-hidden": "true" } },
      [this.probeTitle, this.probeReason],
    );
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
    this.externalButton = h("button", { className: "button", attrs: { type: "button" } }, [
      icon("external"),
      "Open in external player",
    ]);
    this.externalButton.addEventListener("click", () => {
      this.handOver();
    });
    this.resumeButton = h("button", { className: "button", attrs: { type: "button", hidden: true } }, [
      icon("play"),
      "Watch here again",
    ]);
    this.resumeButton.addEventListener("click", () => {
      this.watchHere();
    });
    this.copyButton = h("button", { className: "button", attrs: { type: "button", hidden: true } }, [
      icon("copy"),
      "Copy link",
    ]);
    this.copyButton.addEventListener("click", () => {
      this.copyLink();
    });
    this.clock = h("time", { className: "player-clock" });
    startClock(this.clock);
    this.topBar = h("div", { className: "player-top" }, [this.title, this.clock]);
    this.actions = h("div", { className: "player-actions" }, [
      backButton,
      restartButton,
      this.externalButton,
      this.resumeButton,
      this.copyButton,
    ]);
    this.root = h("div", { className: "player", attrs: { hidden: true, role: "dialog", "aria-label": "Player" } }, [
      this.video,
      this.waiting,
      this.waitingProbe,
      h("div", { className: "player-overlay" }, [this.topBar, this.stats, this.actions]),
    ]);
    this.root.addEventListener("pointermove", () => {
      this.showOverlay();
    });
    // The picture changes size with the window (full screen included) and with the stream.
    window.addEventListener("resize", () => {
      this.placeStats();
    });
    for (const event of ["loadedmetadata", "resize", "emptied"]) {
      this.video.addEventListener(event, () => {
        this.placeStats();
      });
    }
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
    this.stream = stream;
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
      const request = this.root
        .requestFullscreen()
        .catch(() => {
          // Not allowed (for example without a user gesture): the player still covers the window.
        })
        .then(() => {
          if (this.fullscreenRequest === request) {
            this.fullscreenRequest = undefined;
          }
        });
      this.fullscreenRequest = request;
    }
    this.backButton.focus();
    this.showOverlay();
  }

  update(snapshot: Snapshot, time: PageTime): void {
    if (this.streamId === undefined) {
      return;
    }
    const stream = snapshot.streams.find((candidate) => candidate.id === this.streamId);
    if (stream === undefined) {
      this.navigator.back();
      return;
    }
    this.stream = stream;
    this.follow(stream);
    setText(this.title, stream.name);
    const { state, values } = playerStats(stream, snapshot.paths, time);
    this.disabled = state === "stopped";
    // Its broadcast sends nothing new: the last picture would be old, so it doesn't show.
    this.staleSource = state === "stale-source" ? (stream.message ?? "") : undefined;
    this.showNoPicture();
    const restartText = this.disabled ? "Enable stream" : "Restart stream";
    if (this.restartLabel.data !== restartText) {
      this.restartLabel.data = restartText;
    }
    for (const { key, row, value } of this.statRows) {
      const text = values[key];
      row.hidden = text === undefined;
      setText(value, text ?? "");
      // The state takes its colour, as on the tiles (Disabled reads lighter here: see the styles).
      value.className = key === "state" ? `state-${state}` : "";
    }
    // The line that says the page hears nothing is part of the window, so it is set first.
    this.showStale(time);
    this.placeStats();
  }

  /**
   * Says why the page shows no picture, while it shows none, and offers the buttons that fit. A
   * disabled stream says so first: it has nothing to hand over. A stream that plays in an external
   * player says that, whatever its state, which the stats window gives.
   */
  private showNoPicture(): void {
    this.root.classList.toggle("waiting-for-source", this.staleSource !== undefined);
    this.root.classList.toggle("disabled", this.disabled);
    const message = this.noPictureMessage();
    this.waiting.hidden = message === undefined;
    this.waitingProbe.hidden = this.waiting.hidden;
    setText(this.waitingTitle, message?.title ?? "");
    setText(this.waitingReason, message?.reason ?? "");
    setText(this.probeTitle, message?.title ?? "");
    setText(this.probeReason, message?.reason ?? "");
    const handedOver = this.handOff !== undefined;
    // Read before a button goes: the browser may take the focus off a hidden one right away.
    const focused = document.activeElement;
    this.externalButton.hidden = this.disabled || handedOver;
    this.resumeButton.hidden = !handedOver;
    this.copyButton.hidden = !handedOver;
    // A button that just went (the stream was disabled under it) can't keep the focus.
    if (focused instanceof HTMLButtonElement && focused.hidden && this.actions.contains(focused)) {
      this.backButton.focus();
    }
  }

  private noPictureMessage(): { title: string; reason: string } | undefined {
    if (this.disabled) {
      return { title: "This stream is disabled", reason: "Enable it to watch it." };
    }
    if (this.handOff !== undefined) {
      return handOffMessage(this.handOff, document.fullscreenElement !== null);
    }
    if (this.staleSource !== undefined) {
      return { title: "Waiting for the live broadcast", reason: this.staleSource };
    }
    return undefined;
  }

  /**
   * Puts the stats window at the left of the picture, a quarter of the way down it, wherever the
   * picture is drawn: a stream that isn't 16:9 leaves black bars, above and below or on the sides.
   * While there is no picture (none loaded yet, or none shows), the whole screen counts. On a short
   * screen, the window moves up rather than cover Back and Restart, and while the window shows, the
   * message that says why there is no picture moves out from under it.
   */
  private placeStats(): void {
    if (this.root.hidden) {
      return;
    }
    const shown =
      !this.root.classList.contains("waiting-for-source") &&
      !this.root.classList.contains("disabled") &&
      this.video.videoWidth > 0 &&
      this.video.videoHeight > 0;
    const picture = pictureRect(
      { width: this.root.clientWidth, height: this.root.clientHeight },
      shown ? { width: this.video.videoWidth, height: this.video.videoHeight } : null,
    );
    setPixels(this.stats, "--picture-left", picture.left);
    // The window, the controls and the message all cover the player, so their offsets compare.
    // Reading them lays the page out once, with the window's new width.
    const height = this.stats.offsetHeight;
    const top = statsTop(picture, height, {
      top: this.topBar.offsetTop + this.topBar.offsetHeight + STATS_GAP,
      bottom: this.actions.offsetTop - STATS_GAP,
    });
    setPixels(this.stats, "--stats-top", top);
    this.placeWaiting(top, height);
  }

  /**
   * Moves the message that says why there is no picture out from under the stats window (whose top
   * and height are given), when the window would cover it in the middle of the screen. The message
   * takes that room only while the window shows (see the styles).
   */
  private placeWaiting(top: number, height: number): void {
    const message = [this.probeTitle, this.probeReason];
    const room = this.waiting.hidden
      ? null
      : waitingRoom(
          { width: this.root.clientWidth, height: this.root.clientHeight },
          {
            left: Math.min(...message.map((line) => line.offsetLeft)),
            height: this.probeReason.offsetTop + this.probeReason.offsetHeight - this.probeTitle.offsetTop,
          },
          { top, right: this.stats.offsetLeft + this.stats.offsetWidth, bottom: top + height },
          this.actions.offsetTop,
          STATS_GAP,
        );
    // Set only when they change, so that an update doesn't break into the slide.
    for (const side of WAITING_SIDES) {
      const pixels = room?.[side];
      if (pixels === undefined) {
        this.waiting.style.removeProperty(`--waiting-${side}`);
      } else {
        setPixels(this.waiting, `--waiting-${side}`, pixels);
      }
    }
  }

  /** While the page hears nothing, a line above the stats says so. */
  private showStale(time: PageTime): void {
    this.connection.hidden = !time.stale;
    setText(this.connection, time.stale ? staleNotice(time) : "");
    if (time.stale === this.stale) {
      return;
    }
    // The picture just freezes, so the overlay shows the reason, and keeps showing it.
    this.stale = time.stale;
    this.showOverlay();
  }

  /**
   * Plays the stream and counts as its viewer while it is enabled and plays here. A disabled stream
   * has no output to ask for, and nobody watches it; once it is enabled, the player starts by
   * itself, also when the stream was handed to an external player before: disabling it stopped
   * that player too.
   */
  private follow(stream: StreamView): void {
    if (!stream.enabled) {
      this.handOff = undefined;
    }
    const plays = stream.enabled && this.handOff === undefined;
    if (plays === this.following) {
      return;
    }
    this.following = plays;
    if (plays) {
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
    this.stream = undefined;
    this.handOff = undefined;
    this.following = false;
    // The next `update` finds the page stale or not afresh, and raises the overlay if it is.
    this.stale = false;
    this.watch.show(null);
    this.detach();
    this.root.hidden = true;
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (this.fullscreenRequest !== undefined) {
      // Back came before the browser went full screen (OK then Back at once on a remote): it still
      // goes, after the player closed, and would leave the page black, without focus, deaf to keys.
      // It leaves full screen as soon as it is in, unless the player opened again meanwhile.
      void this.fullscreenRequest.then(() => {
        if (this.streamId === undefined && document.fullscreenElement === this.root) {
          void document.exitFullscreen().catch(() => undefined);
        }
      });
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
      if (!this.stale) {
        this.root.classList.remove("show-overlay");
      }
    }, OVERLAY_MS);
  }

  /**
   * Hands the stream to an external player, and stops playing it here at once: a TV decodes one
   * stream at a time, and two players would both have sound. The page says what to do next where
   * the picture was, since a browser in full screen shows nothing of a download.
   */
  private handOver(): void {
    const stream = this.stream;
    if (stream?.enabled !== true) {
      return;
    }
    const handOff = handOffFor(stream.name, absoluteUrl(stream.hls.full, location.href), navigator.userAgent);
    openExternally(handOff, this.root);
    this.handOff = handOff;
    this.showHandOff(stream, this.resumeButton);
  }

  /** Plays the stream here again, after it was handed to an external player. */
  private watchHere(): void {
    const stream = this.stream;
    if (stream === undefined) {
      return;
    }
    this.handOff = undefined;
    this.showHandOff(stream, this.externalButton);
  }

  /** Shows the player with the stream just handed over or taken back; the focus goes to `button`. */
  private showHandOff(stream: StreamView, button: HTMLButtonElement): void {
    this.follow(stream);
    this.showNoPicture();
    this.placeStats();
    button.focus();
  }

  /** Copies the address of the stream that was handed over, for a player that didn't get it. */
  private copyLink(): void {
    if (this.handOff === undefined) {
      return;
    }
    void copyText(this.handOff.url, this.root).then((copied) => {
      if (copied) {
        toast("Link copied");
      } else {
        toast("This browser doesn't let the page copy. The address is on the screen.", "error");
      }
    });
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

/** Sets a length in pixels on an element's style, leaving it alone when it already has it. */
function setPixels(element: HTMLElement, property: string, pixels: number): void {
  const value = `${String(pixels)}px`;
  if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
}
