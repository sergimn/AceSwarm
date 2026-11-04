import type { Snapshot, StreamView } from "@aceswarm/shared/api-types";
import { api } from "./api.ts";
import { confirmButton, dialogShell, errorMessage, h, icon, toast } from "./dom.ts";
import { STATE_LABELS } from "./format.ts";
import type { Navigator } from "./navigation.ts";
import type { PreviewMode } from "./previews.ts";

const KIND_LABELS = { "content-id": " · content ID", infohash: " · infohash", unknown: "" } as const;

interface Row {
  element: HTMLElement;
  name: HTMLElement;
  identifier: HTMLElement;
  state: HTMLElement;
  toggle: HTMLButtonElement;
}

/** Lists every stream with restart, enable/disable and remove actions, plus the preview setting. */
export class ManageDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private readonly previewButtons: Record<PreviewMode, HTMLButtonElement>;

  constructor(navigator: Navigator, previewMode: PreviewMode, onPreviewMode: (mode: PreviewMode) => void) {
    this.navigator = navigator;
    const shell = dialogShell("Streams", () => {
      this.navigator.back();
    });
    this.dialog = shell.dialog;
    this.list = h("ul", { className: "rows" });
    this.empty = h("p", { className: "muted", text: "No streams yet." });
    const choose = (mode: PreviewMode): HTMLButtonElement => {
      const button = h("button", {
        className: "segment",
        text: mode === "video" ? "Live video" : "Thumbnails only",
        attrs: { type: "button" },
      });
      button.addEventListener("click", () => {
        onPreviewMode(mode);
        this.markPreviewMode(mode);
      });
      return button;
    };
    this.previewButtons = { video: choose("video"), thumbnails: choose("thumbnails") };
    this.markPreviewMode(previewMode);
    shell.body.append(
      h("div", { className: "setting" }, [
        h("span", { text: "Tile previews" }),
        h("div", { className: "segments" }, [this.previewButtons.video, this.previewButtons.thumbnails]),
      ]),
      this.list,
      this.empty,
    );
  }

  open(snapshot: Snapshot | undefined): void {
    if (snapshot !== undefined) {
      this.update(snapshot);
    }
    this.dialog.showModal();
    this.navigator.open({
      root: this.dialog,
      close: () => {
        this.dialog.close();
      },
    });
    this.navigator.focusFirst(this.dialog);
  }

  update(snapshot: Snapshot): void {
    const seen = new Set<string>();
    for (const stream of snapshot.streams) {
      seen.add(stream.id);
      let row = this.rows.get(stream.id);
      if (row === undefined) {
        row = this.createRow(stream);
        this.rows.set(stream.id, row);
        this.list.append(row.element);
      }
      row.name.textContent = stream.name;
      row.identifier.textContent = `${stream.aceId}${KIND_LABELS[stream.aceIdKind ?? "unknown"]}`;
      const state = stream.enabled ? stream.state : "stopped";
      row.state.textContent = STATE_LABELS[state];
      row.state.className = `badge state-${state}`;
      row.toggle.textContent = stream.enabled ? "Disable" : "Enable";
      row.toggle.dataset["enabled"] = String(stream.enabled);
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.element.remove();
        this.rows.delete(id);
      }
    }
    this.empty.hidden = this.rows.size > 0;
  }

  private markPreviewMode(mode: PreviewMode): void {
    for (const [key, button] of Object.entries(this.previewButtons)) {
      button.setAttribute("aria-pressed", String(key === mode));
    }
  }

  private createRow(stream: StreamView): Row {
    const name = h("span", { className: "row-title" });
    const state = h("span", { className: "badge" });
    const restart = h("button", { className: "button", attrs: { type: "button" } }, [icon("refresh"), "Restart"]);
    restart.addEventListener("click", () => {
      api
        .restartStream(stream.id)
        .then(() => {
          toast("Restarting the stream");
        })
        .catch((error: unknown) => {
          toast(errorMessage(error), "error");
        });
    });
    const toggle = h("button", { className: "button", attrs: { type: "button" } });
    toggle.addEventListener("click", () => {
      const enabled = toggle.dataset["enabled"] !== "true";
      api.updateStream(stream.id, { enabled }).catch((error: unknown) => {
        toast(errorMessage(error), "error");
      });
    });
    const remove = confirmButton("Remove", "Press again to remove", async () => {
      await api.removeStream(stream.id);
      toast("Stream removed");
    });
    const identifier = h("span", { className: "row-sub mono", text: stream.aceId });
    const element = h("li", { className: "row" }, [
      h("div", { className: "row-main" }, [name, identifier]),
      state,
      h("div", { className: "row-actions" }, [restart, toggle, remove]),
    ]);
    return { element, name, identifier, state, toggle };
  }
}
