import type { HotStandbyView, Settings, Snapshot } from "@aceswarm/shared/api-types";
import { api } from "./api.ts";
import { dialogShell, errorMessage, h, setText, switchSetting, toast, type SwitchSetting } from "./dom.ts";
import { favouritePathHint, sharedEnginesHint } from "./hints.ts";
import type { Navigator } from "./navigation.ts";
import { favouriteOptions, type FavouriteOption } from "./paths.ts";
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

/** What a snapshot says about the favourite path and the paths to choose from. */
type FavouriteSnapshot = Pick<
  Snapshot,
  "paths" | "wireguardOnly" | "gatewayReachable" | "favouritePath" | "hotStandby"
>;

/** A choice's button: its label, and in brackets why no stream can move to its path now. */
function favouriteLabel(option: FavouriteOption): string {
  return option.unavailable === null ? option.label : `${option.label} (${option.unavailable})`;
}

/**
 * The "Favourite path" setting: a choice for no favourite and one for each network path. A path
 * that is down or off shows in grey, and can be chosen all the same: streams move to it once they
 * can. The choices follow the snapshot, and a button stays the same element while its path is
 * listed, so a remote keeps its focus.
 */
class FavouritePathSetting {
  readonly element: HTMLElement;
  private readonly choices: HTMLElement;
  private readonly hint: HTMLElement;
  /** The buttons by their path's id; the choice of no favourite is under "". */
  private readonly buttons = new Map<string, HTMLButtonElement>();
  /** The paths' labels, as the buttons show them without what is in brackets. */
  private readonly labels = new Map<string, string>();
  private last: FavouriteSnapshot | undefined;
  private saving = false;

  constructor() {
    this.hint = h("p", {
      className: "muted small",
      text: favouritePathHint(undefined, 0, false).text,
      attrs: { id: "favourite-path-hint" },
    });
    this.choices = h("div", {
      className: "segments wrap",
      attrs: { role: "group", "aria-labelledby": "favourite-path-label", "aria-describedby": "favourite-path-hint" },
    });
    this.element = h("div", { className: "setting" }, [
      h("div", { className: "setting-text" }, [
        h("span", { className: "row-title", text: "Favourite path", attrs: { id: "favourite-path-label" } }),
        this.hint,
      ]),
      this.choices,
    ]);
    this.show([{ id: null, label: "None", selected: true, unavailable: null }]);
  }

  render(snapshot: FavouriteSnapshot): void {
    this.last = snapshot;
    if (this.saving) {
      return;
    }
    const options = favouriteOptions(snapshot);
    this.show(options);
    const chosen = options.find((option) => option.selected);
    const hint = favouritePathHint(chosen, snapshot.favouritePath.stableSeconds, snapshot.hotStandby.enabled);
    setText(this.hint, hint.text);
    this.hint.classList.toggle("caution", hint.caution);
  }

  private show(options: readonly FavouriteOption[]): void {
    const keys = options.map((option) => option.id ?? "");
    for (const [key, button] of this.buttons) {
      if (!keys.includes(key)) {
        // Its path is gone. Focus goes to the first choice rather than nowhere.
        const focused = document.activeElement === button;
        button.remove();
        this.buttons.delete(key);
        this.labels.delete(key);
        if (focused) {
          this.buttons.get("")?.focus();
        }
      }
    }
    for (const option of options) {
      const button = this.buttons.get(option.id ?? "") ?? this.add(option.id);
      this.labels.set(option.id ?? "", option.label);
      setText(button, favouriteLabel(option));
      button.setAttribute("aria-pressed", String(option.selected));
      button.classList.toggle("unavailable", option.unavailable !== null);
    }
    // Only when the order changed: moving a button takes its focus away.
    const shown = [...this.choices.children];
    const wanted = keys.map((key) => this.buttons.get(key));
    if (shown.length !== wanted.length || shown.some((button, index) => button !== wanted[index])) {
      this.choices.replaceChildren(...wanted.filter((button) => button !== undefined));
    }
  }

  private add(id: string | null): HTMLButtonElement {
    const button = h("button", { className: "segment", attrs: { type: "button", "data-path": id ?? "" } });
    button.addEventListener("click", () => {
      void this.choose(id, button, this.labels.get(id ?? "") ?? "");
    });
    this.buttons.set(id ?? "", button);
    return button;
  }

  private async choose(id: string | null, button: HTMLButtonElement, label: string): Promise<void> {
    if (this.saving || button.getAttribute("aria-pressed") === "true") {
      return;
    }
    this.saving = true;
    this.choices.setAttribute("aria-busy", "true");
    try {
      const saved = await saveSetting("favouritePath", id);
      toast(saved === null ? "No favourite path now" : `${label} is the favourite path now`);
      this.saving = false;
      if (this.last !== undefined) {
        this.render({ ...this.last, favouritePath: { ...this.last.favouritePath, path: saved } });
      }
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      this.saving = false;
      this.choices.removeAttribute("aria-busy");
    }
  }
}

/**
 * The Settings at the bottom of the rail: how the tiles show their previews, which only this
 * browser keeps, and the engine sharing, hot standby and favourite path settings, which the
 * controller keeps for every screen.
 */
export class SettingsDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly previewButtons: Record<PreviewMode, HTMLButtonElement>;
  /** Says why Live video is greyed out, under it, while the admin allows thumbnails only. */
  private readonly thumbnailsOnlyTip: HTMLElement;
  private readonly sharedEngines: SettingSwitch;
  private readonly hotStandby: SettingSwitch;
  private readonly favouritePath = new FavouritePathSetting();
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
        // While the admin allows thumbnails only, neither choice does anything: the browser's own
        // choice stays as it was, for when the admin lifts it.
        if (this.thumbnailsOnly) {
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
      // The tip comes right after Live video: the styles show it while the mouse is on that or a remote focuses it.
      [this.previewButtons.video, this.thumbnailsOnlyTip, this.previewButtons.thumbnails],
    );
    shell.body.append(
      h("div", { className: "setting" }, [previewText, previewChoices]),
      this.sharedEngines.element,
      this.hotStandby.element,
      this.favouritePath.element,
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
    this.favouritePath.render(snapshot);
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
