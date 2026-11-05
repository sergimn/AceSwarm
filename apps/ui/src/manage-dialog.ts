import type { SharedEnginesView, Snapshot, StreamView } from "@aceswarm/shared/api-types";
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

function sharedEnginesHint(view: SharedEnginesView | undefined): string {
  if (view?.enabled !== true) {
    return "Off: every stream has an engine of its own.";
  }
  return [
    "On: streams on the same network path share one engine, which needs much less memory.",
    `It restarts only when a stream someone is watching fails, or more than ${String(view.maxFailures)}`,
    `of its streams fail within ${String(view.failureWindowSeconds)} s.`,
  ].join(" ");
}

/**
 * Lists every stream with restart, enable/disable and remove actions, plus the preview and engine
 * sharing settings.
 */
export class ManageDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private readonly previewButtons: Record<PreviewMode, HTMLButtonElement>;
  private readonly sharedEngines: HTMLButtonElement;
  private readonly sharedEnginesState: HTMLElement;
  private readonly sharedEnginesHint: HTMLElement;
  private savingSharedEngines = false;

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
    this.sharedEnginesState = h("span", { className: "switch-state", attrs: { "aria-hidden": "true" } });
    this.sharedEngines = h(
      "button",
      {
        className: "switch",
        attrs: {
          type: "button",
          role: "switch",
          "aria-checked": "false",
          "aria-labelledby": "shared-engines-label",
          "aria-describedby": "shared-engines-hint",
        },
      },
      [h("span", { className: "switch-track", attrs: { "aria-hidden": "true" } }), this.sharedEnginesState],
    );
    this.sharedEngines.addEventListener("click", () => {
      void this.toggleSharedEngines();
    });
    this.sharedEnginesHint = h("p", {
      className: "muted small",
      text: sharedEnginesHint(undefined),
      attrs: { id: "shared-engines-hint" },
    });
    const sharedEnginesLabel = h("span", {
      className: "row-title",
      text: "One engine per path",
      attrs: { id: "shared-engines-label" },
    });
    shell.body.append(
      h("div", { className: "setting" }, [
        h("span", { text: "Tile previews" }),
        h("div", { className: "segments" }, [this.previewButtons.video, this.previewButtons.thumbnails]),
      ]),
      h("div", { className: "setting" }, [
        h("div", { className: "setting-text" }, [sharedEnginesLabel, this.sharedEnginesHint]),
        this.sharedEngines,
      ]),
      this.list,
      this.empty,
    );
  }

  open(snapshot: Snapshot | undefined): void {
    if (snapshot !== undefined) {
      this.update(snapshot);
    }
    // Open the layer first: it remembers the focused element, and showModal() moves focus.
    this.navigator.open({
      root: this.dialog,
      close: () => {
        this.dialog.close();
      },
    });
    this.dialog.showModal();
    this.navigator.focusFirst(this.dialog);
  }

  update(snapshot: Snapshot): void {
    this.renderSharedEngines(snapshot.sharedEngines);
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

  private renderSharedEngines(view: SharedEnginesView): void {
    if (this.savingSharedEngines) {
      return;
    }
    this.sharedEngines.setAttribute("aria-checked", String(view.enabled));
    this.sharedEnginesState.textContent = view.enabled ? "On" : "Off";
    this.sharedEnginesHint.textContent = sharedEnginesHint(view);
  }

  private async toggleSharedEngines(): Promise<void> {
    if (this.savingSharedEngines) {
      return;
    }
    const wanted = this.sharedEngines.getAttribute("aria-checked") !== "true";
    this.savingSharedEngines = true;
    this.sharedEngines.setAttribute("aria-busy", "true");
    try {
      const settings = await api.updateSettings({ sharedEngines: wanted });
      this.sharedEngines.setAttribute("aria-checked", String(settings.sharedEngines));
      this.sharedEnginesState.textContent = settings.sharedEngines ? "On" : "Off";
      toast(settings.sharedEngines ? "Streams move to one engine per path" : "Streams move to engines of their own");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      this.savingSharedEngines = false;
      this.sharedEngines.removeAttribute("aria-busy");
    }
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
