import "flag-icons/css/flag-icons.min.css";
import "./styles.css";
import type { Snapshot } from "@aceswarm/shared/api-types";
import { AddStreamDialog } from "./add-stream-dialog.ts";
import { api, subscribeSnapshots, type ConnectionStatus } from "./api.ts";
import { errorMessage, toast } from "./dom.ts";
import { Grid } from "./grid.ts";
import { ManageDialog } from "./manage-dialog.ts";
import { Navigator } from "./navigation.ts";
import { NetworkDialog } from "./network-dialog.ts";
import { Player } from "./player.ts";
import { PreviewManager, type PreviewMode } from "./previews.ts";

const PREVIEW_MODE_KEY = "aceswarm.previewMode";
const MAX_PREVIEWS = 12;

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
};

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`missing element ${selector}`);
  }
  return found;
}

function loadPreviewMode(): PreviewMode {
  try {
    return localStorage.getItem(PREVIEW_MODE_KEY) === "thumbnails" ? "thumbnails" : "video";
  } catch {
    return "video";
  }
}

function savePreviewMode(mode: PreviewMode): void {
  try {
    localStorage.setItem(PREVIEW_MODE_KEY, mode);
  } catch {
    // Storage can be unavailable (private mode); the setting then lasts for this visit.
  }
}

/** Wires the grid, the player and the dialogs to the live snapshot. */
class App {
  private readonly navigator = new Navigator(element("#app"));
  private readonly previews = new PreviewManager(loadPreviewMode(), MAX_PREVIEWS);
  private readonly player = new Player(this.navigator);
  private readonly grid = new Grid(element("#grid"), this.previews, (id) => {
    this.openPlayer(id);
  });
  private readonly streamForm = new AddStreamDialog(this.navigator);
  private readonly streamList = new ManageDialog(this.navigator, this.previews.currentMode, (mode) => {
    this.previews.setMode(mode);
    savePreviewMode(mode);
  });
  private readonly network = new NetworkDialog(this.navigator);
  private readonly summary = element("#summary");
  private readonly connection = element("#connection");
  private readonly empty = element("#empty");
  private snapshot: Snapshot | undefined;
  private focusedOnce = false;

  constructor() {
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
      this.network.open(this.snapshot);
    });
  }

  connect(): void {
    subscribeSnapshots(
      (snapshot) => {
        this.render(snapshot);
      },
      (status) => {
        this.connection.textContent = CONNECTION_LABELS[status];
        this.connection.dataset["status"] = status;
      },
    );
  }

  render(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.grid.render(snapshot, Date.now());
    this.player.update(snapshot);
    this.streamList.update(snapshot);
    this.network.update(snapshot);
    const live = snapshot.streams.filter((stream) => stream.state === "playing").length;
    const pathsUp = snapshot.paths.filter((path) => path.up).length;
    this.summary.textContent = [
      `${String(snapshot.streams.length)} streams`,
      `${String(live)} live`,
      `${String(pathsUp)}/${String(snapshot.paths.length)} network paths up`,
    ].join(" · ");
    this.empty.hidden = snapshot.streams.length > 0;
    if (this.focusedOnce || this.navigator.depth > 0) {
      return;
    }
    this.focusedOnce = true;
    (this.grid.firstTile() ?? element("[data-action=add]")).focus();
  }

  private openPlayer(id: string): void {
    const stream = this.snapshot?.streams.find((candidate) => candidate.id === id);
    if (this.snapshot === undefined || stream === undefined) {
      return;
    }
    this.player.open(stream);
    this.player.update(this.snapshot);
  }
}

const app = new App();
app.connect();
try {
  app.render(await api.snapshot());
} catch (error) {
  toast(`Could not load streams: ${errorMessage(error)}`, "error");
}
