import "flag-icons/css/flag-icons.min.css";
import "./styles.css";
import type { Snapshot } from "@aceswarm/shared/api-types";
import { AddStreamDialog } from "./add-stream-dialog.ts";
import { api, subscribeSnapshots, type ConnectionStatus } from "./api.ts";
import { onTick, startClock } from "./clock.ts";
import { errorMessage, placeToasts, setText, toast } from "./dom.ts";
import { Grid } from "./grid.ts";
import { trackInputMode } from "./input-mode.ts";
import { connectionLabel, PageClock, type PageTime } from "./liveness.ts";
import { ManageDialog } from "./manage-dialog.ts";
import { Navigator } from "./navigation.ts";
import { NetworkDialog } from "./network-dialog.ts";
import { formatSummary } from "./paths.ts";
import { Player } from "./player.ts";
import { effectivePreviewMode, loadPreviewChoice, savePreviewChoice } from "./preview-mode.ts";
import { PreviewManager } from "./previews.ts";
import { SettingsDialog } from "./settings-dialog.ts";
import { WatchReporter } from "./watch.ts";

const MAX_PREVIEWS = 12;

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`missing element ${selector}`);
  }
  return found;
}

/** Wires the grid, the player and the dialogs to the live snapshot. */
class App {
  private readonly navigator = new Navigator(element("#app"), placeToasts);
  /** This browser's choice under Settings. */
  private previewChoice = loadPreviewChoice();
  /** The admin allows thumbnails only, as the last snapshot said: the tiles then ignore the choice. */
  private thumbnailsOnly = false;
  // No tile plays before the first snapshot, which says whether the admin allows Live video.
  private readonly previews = new PreviewManager(this.previewChoice, MAX_PREVIEWS);
  private readonly watch = new WatchReporter();
  private readonly player = new Player(this.navigator, this.watch);
  private readonly grid = new Grid(element("#grid"), this.previews, (id) => {
    this.openPlayer(id);
  });
  private readonly streamForm = new AddStreamDialog(this.navigator);
  private readonly streamList = new ManageDialog(this.navigator);
  private readonly network = new NetworkDialog(this.navigator);
  private readonly settings = new SettingsDialog(this.navigator, this.previewChoice, (mode) => {
    this.previewChoice = mode;
    savePreviewChoice(mode);
    this.showPreviews();
  });
  private readonly summary = element("#summary");
  private readonly connection = element("#connection");
  private readonly empty = element("#empty");
  private readonly pageClock = new PageClock();
  private snapshot: Snapshot | undefined;
  private connectionStatus: ConnectionStatus = "connecting";
  private focusedOnce = false;

  constructor() {
    startClock(element("#clock"));
    element("[data-action=add]").addEventListener("click", () => {
      this.streamForm.open();
    });
    element("[data-action=empty-add]").addEventListener("click", () => {
      this.streamForm.open();
    });
    element("[data-action=streams]").addEventListener("click", () => {
      this.streamList.open(this.snapshot);
    });
    element("[data-action=network]").addEventListener("click", () => {
      this.network.open();
    });
    element("[data-action=settings]").addEventListener("click", () => {
      this.settings.open(this.snapshot);
    });
  }

  connect(): void {
    subscribeSnapshots(
      (snapshot) => {
        this.render(snapshot);
      },
      (status) => {
        this.connectionStatus = status;
        this.showConnection(this.pageClock.read());
      },
    );
    // Snapshots stop when the controller does, so ages can't wait for the next one.
    onTick(() => {
      this.refreshAges();
    });
  }

  render(snapshot: Snapshot): void {
    this.pageClock.receive(snapshot.generatedAt);
    const time = this.pageClock.read();
    this.snapshot = snapshot;
    this.watch.setInterval(snapshot.viewerPingSeconds);
    // Before the grid: a new tile must not start a live preview the admin doesn't allow.
    this.thumbnailsOnly = snapshot.tilePreviews.thumbnailsOnly;
    this.showPreviews();
    this.grid.render(snapshot, time);
    this.player.update(snapshot, time);
    this.showConnection(time);
    this.streamList.update(snapshot);
    this.network.update(snapshot);
    this.settings.update(snapshot);
    this.summary.textContent = formatSummary(snapshot);
    this.empty.hidden = snapshot.streams.length > 0;
    if (this.focusedOnce || this.navigator.depth > 0) {
      return;
    }
    this.focusedOnce = true;
    (this.grid.firstTile() ?? element("[data-action=add]")).focus();
  }

  /** Plays the tiles' live previews, or shows their thumbnails only. */
  private showPreviews(): void {
    const mode = effectivePreviewMode(this.previewChoice, this.thumbnailsOnly);
    if (mode !== this.previews.currentMode) {
      this.previews.setMode(mode);
    }
  }

  /** Every second: what is shown ages, and a page that hears nothing says so. */
  private refreshAges(): void {
    if (this.snapshot === undefined) {
      return;
    }
    const time = this.pageClock.read();
    this.grid.refreshAges(time);
    this.player.update(this.snapshot, time);
    this.showConnection(time);
  }

  private showConnection(time: PageTime): void {
    const { text, status } = connectionLabel(this.connectionStatus, time);
    setText(this.connection, text);
    this.connection.dataset["status"] = status;
    // The styles dim what is old; the player and the dialogs cover the connection label.
    document.body.toggleAttribute("data-stale", time.stale);
  }

  private openPlayer(id: string): void {
    const stream = this.snapshot?.streams.find((candidate) => candidate.id === id);
    if (this.snapshot === undefined || stream === undefined) {
      return;
    }
    this.player.open(stream);
    this.player.update(this.snapshot, this.pageClock.read());
  }
}

trackInputMode(".tile");
const app = new App();
app.connect();
try {
  app.render(await api.snapshot());
} catch (error) {
  toast(`Could not load streams: ${errorMessage(error)}`, "error");
}
