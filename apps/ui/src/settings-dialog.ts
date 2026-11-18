import type { HotStandbyView, Settings, Snapshot } from "@aceswarm/shared/api-types";
import { api } from "./api.ts";
import { dialogShell, errorMessage, h, setText, switchSetting, toast, type SwitchSetting } from "./dom.ts";
import { sharedEnginesHint } from "./hints.ts";
import type { Navigator } from "./navigation.ts";
import { effectivePreviewMode, THUMBNAILS_ONLY_TIP, type PreviewMode } from "./preview-mode.ts";

const PREVIEW_LABELS: Record<PreviewMode, string> = { video: "Live video", thumbnails: "Thumbnails only" };

const TILE_PREVIEWS_HINT = [
  "Live video plays the tiles on screen. Thumbnails only shows a still picture of each stream instead,",
  "which is lighter for a TV or a phone. Each browser keeps its own choice.",
].join(" ");

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

/** An on/off switch for one of the settings, with a hint that follows the snapshot. */
class SettingSwitch {
  readonly element: HTMLElement;
  private readonly control: SwitchSetting;
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
    this.control = switchSetting(id, label, hint);
    this.element = this.control.element;
    this.control.button.addEventListener("click", () => {
      void this.toggle();
    });
  }

  render(on: boolean, hint: string): void {
    if (this.saving) {
      return;
    }
    this.control.show(on);
    setText(this.control.hint, hint);
  }

  private async toggle(): Promise<void> {
    if (this.saving) {
      return;
    }
    const { button } = this.control;
    const wanted = button.getAttribute("aria-checked") !== "true";
    this.saving = true;
    button.setAttribute("aria-busy", "true");
    try {
      const on = await this.save(wanted);
      this.control.show(on);
      toast(this.saved(on));
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      this.saving = false;
      button.removeAttribute("aria-busy");
    }
  }
}

async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings[K]> {
  const settings = await api.updateSettings({ [key]: value });
  return settings[key];
}

/**
 * The Settings at the bottom of the rail: how the tiles show their previews, which only this
 * browser keeps, and the engine sharing and hot standby settings, which the controller keeps for
 * every screen.
 */
export class SettingsDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly previewButtons: Record<PreviewMode, HTMLButtonElement>;
  /** Says why Live video is greyed out, under it, while the admin allows thumbnails only. */
  private readonly thumbnailsOnlyTip: HTMLElement;
  private readonly sharedEngines: SettingSwitch;
  private readonly hotStandby: SettingSwitch;
  /** This browser's choice. */
  private previewChoice: PreviewMode;
  /** The admin allows thumbnails only, as the last snapshot said. */
  private thumbnailsOnly = false;

  constructor(navigator: Navigator, previewChoice: PreviewMode, onPreviewChoice: (mode: PreviewMode) => void) {
    this.navigator = navigator;
    this.previewChoice = previewChoice;
    const shell = dialogShell("Settings", () => {
      this.navigator.back();
    });
    this.dialog = shell.dialog;
    const choose = (mode: PreviewMode): HTMLButtonElement => {
      const button = h("button", { className: "segment", text: PREVIEW_LABELS[mode], attrs: { type: "button" } });
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-disabled") === "true") {
          // A tap shows why it is greyed out, as the mouse over it or the remote's focus on it do.
          button.focus();
          return;
        }
        this.previewChoice = mode;
        onPreviewChoice(mode);
        this.renderPreviews();
      });
      return button;
    };
    this.previewButtons = { video: choose("video"), thumbnails: choose("thumbnails") };
    // Live video stays focusable when greyed out: a remote reaches it, and its focus shows the tip.
    this.thumbnailsOnlyTip = h("span", {
      className: "tip",
      text: THUMBNAILS_ONLY_TIP,
      attrs: { id: "thumbnails-only-tip", role: "tooltip", hidden: true },
    });
    this.renderPreviews();
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
    // Laid out like the switches below it: its label and hint on the left, its choices on the right.
    const previewText = h("div", { className: "setting-text" }, [
      h("span", { className: "row-title", text: "Tile previews", attrs: { id: "tile-previews-label" } }),
      h("p", { className: "muted small", text: TILE_PREVIEWS_HINT, attrs: { id: "tile-previews-hint" } }),
    ]);
    const previewChoices = h(
      "div",
      {
        className: "segments",
        attrs: { role: "group", "aria-labelledby": "tile-previews-label", "aria-describedby": "tile-previews-hint" },
      },
      // The tip comes right after Live video: the styles show it while that is hovered or focused.
      [this.previewButtons.video, this.thumbnailsOnlyTip, this.previewButtons.thumbnails],
    );
    shell.body.append(
      h("div", { className: "setting" }, [previewText, previewChoices]),
      this.sharedEngines.element,
      this.hotStandby.element,
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
    if (snapshot.tilePreviews.thumbnailsOnly !== this.thumbnailsOnly) {
      this.thumbnailsOnly = snapshot.tilePreviews.thumbnailsOnly;
      this.renderPreviews();
    }
    this.sharedEngines.render(snapshot.sharedEngines.enabled, sharedEnginesHint(snapshot.sharedEngines));
    this.hotStandby.render(
      snapshot.hotStandby.enabled,
      hotStandbyHint(snapshot.hotStandby, snapshot.sharedEngines.enabled),
    );
  }

  /** Presses what the tiles show, and greys out Live video while the admin allows thumbnails only. */
  private renderPreviews(): void {
    const shown = effectivePreviewMode(this.previewChoice, this.thumbnailsOnly);
    for (const [key, button] of Object.entries(this.previewButtons)) {
      button.setAttribute("aria-pressed", String(key === shown));
    }
    const video = this.previewButtons.video;
    this.thumbnailsOnlyTip.hidden = !this.thumbnailsOnly;
    if (this.thumbnailsOnly) {
      video.setAttribute("aria-disabled", "true");
      video.setAttribute("aria-describedby", this.thumbnailsOnlyTip.id);
    } else {
      video.removeAttribute("aria-disabled");
      video.removeAttribute("aria-describedby");
    }
  }
}
