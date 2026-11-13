import type { HotStandbyView, Settings, SharedEnginesView, Snapshot, StreamView } from "@aceswarm/shared/api-types";
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

function hotStandbyHint(view: HotStandbyView | undefined, sharing: boolean): string {
  if (view?.enabled !== true) {
    return "Off: a failing stream starts a new engine on another path, which can take a minute to find peers.";
  }
  const paths = view.maxPaths === 0 ? "every other network path" : `up to ${String(view.maxPaths)} other paths`;
  const engines = sharing ? "a session on that path's engine" : "an engine of its own there";
  return [
    `On: every stream also pulls its video through ${paths}, with ${engines}, so it moves there within`,
    `seconds when its path fails (after ${String(view.failoverSeconds)} s without video). It costs that much`,
    "more download, and memory for each engine.",
  ].join(" ");
}

/** An on/off switch for one of the settings, with a label and a hint that follow the snapshot. */
class SettingSwitch {
  readonly element: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly state: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly save: (on: boolean) => Promise<boolean>;
  private readonly saved: (on: boolean) => string;
  private saving = false;

  constructor(
    id: string,
    label: string,
    hint: string,
    save: (on: boolean) => Promise<boolean>,
    saved: (on: boolean) => string,
  ) {
    this.save = save;
    this.saved = saved;
    this.state = h("span", { className: "switch-state", attrs: { "aria-hidden": "true" } });
    this.button = h(
      "button",
      {
        className: "switch",
        attrs: {
          type: "button",
          role: "switch",
          "aria-checked": "false",
          "aria-labelledby": `${id}-label`,
          "aria-describedby": `${id}-hint`,
        },
      },
      [h("span", { className: "switch-track", attrs: { "aria-hidden": "true" } }), this.state],
    );
    this.button.addEventListener("click", () => {
      void this.toggle();
    });
    this.hint = h("p", { className: "muted small", text: hint, attrs: { id: `${id}-hint` } });
    const title = h("span", { className: "row-title", text: label, attrs: { id: `${id}-label` } });
    this.element = h("div", { className: "setting" }, [
      h("div", { className: "setting-text" }, [title, this.hint]),
      this.button,
    ]);
  }

  render(on: boolean, hint: string): void {
    if (this.saving) {
      return;
    }
    this.show(on);
    this.hint.textContent = hint;
  }

  private show(on: boolean): void {
    this.button.setAttribute("aria-checked", String(on));
    this.state.textContent = on ? "On" : "Off";
  }

  private async toggle(): Promise<void> {
    if (this.saving) {
      return;
    }
    const wanted = this.button.getAttribute("aria-checked") !== "true";
    this.saving = true;
    this.button.setAttribute("aria-busy", "true");
    try {
      const on = await this.save(wanted);
      this.show(on);
      toast(this.saved(on));
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      this.saving = false;
      this.button.removeAttribute("aria-busy");
    }
  }
}

async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings[K]> {
  const settings = await api.updateSettings({ [key]: value });
  return settings[key];
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
 * Lists every stream with restart, enable/disable and remove actions, plus the preview, engine
 * sharing and hot standby settings.
 */
export class ManageDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private readonly previewButtons: Record<PreviewMode, HTMLButtonElement>;
  private readonly sharedEngines: SettingSwitch;
  private readonly hotStandby: SettingSwitch;

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
    this.sharedEngines = new SettingSwitch(
      "shared-engines",
      "One engine per path",
      sharedEnginesHint(undefined),
      async (on) => saveSetting("sharedEngines", on),
      (on) => (on ? "Streams move to one engine per path" : "Streams move to engines of their own"),
    );
    this.hotStandby = new SettingSwitch(
      "hot-standby",
      "Hot standby on other paths",
      hotStandbyHint(undefined, false),
      async (on) => saveSetting("hotStandby", on),
      (on) => (on ? "Streams start standbys on the other paths" : "Streams remove their standbys"),
    );
    shell.body.append(
      h("div", { className: "setting" }, [
        h("span", { text: "Tile previews" }),
        h("div", { className: "segments" }, [this.previewButtons.video, this.previewButtons.thumbnails]),
      ]),
      this.sharedEngines.element,
      this.hotStandby.element,
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
    this.sharedEngines.render(snapshot.sharedEngines.enabled, sharedEnginesHint(snapshot.sharedEngines));
    this.hotStandby.render(
      snapshot.hotStandby.enabled,
      hotStandbyHint(snapshot.hotStandby, snapshot.sharedEngines.enabled),
    );
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
