import type { PathStatus, Snapshot, WireguardProfileView } from "@aceswarm/shared/api-types";
import { api, ApiError } from "./api.ts";
import { confirmButton, dialogShell, errorMessage, h, toast } from "./dom.ts";
import { formatLoss, formatRtt } from "./format.ts";
import type { Navigator } from "./navigation.ts";

const STRATEGY_LABELS = {
  "sticky-best": "Sticky: streams stay on their path until it fails, then move to the best one",
  "round-robin": "Round robin: new streams are spread across the paths that are up",
} as const;

function profileName(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/\.conf$/, "")
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/^[-_]+|-+$/g, "")
    .slice(0, 32);
}

/** Network paths (direct and WireGuard) with their health, and WireGuard profile management. */
export class NetworkDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly paths: HTMLElement;
  private readonly strategy: HTMLElement;
  private readonly profiles: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly name: HTMLInputElement;
  private readonly config: HTMLTextAreaElement;
  private readonly errors: HTMLElement;
  private snapshot: Snapshot | undefined;

  constructor(navigator: Navigator) {
    this.navigator = navigator;
    const shell = dialogShell("Network", () => {
      this.navigator.back();
    });
    this.dialog = shell.dialog;
    this.paths = h("ul", { className: "rows" });
    this.strategy = h("p", { className: "muted" });
    this.profiles = h("ul", { className: "rows" });
    this.name = h("input", {
      className: "input",
      attrs: { required: true, maxlength: "32", pattern: "[a-z0-9][a-z0-9_-]*", placeholder: "e.g. mullvad-de" },
    });
    this.config = h("textarea", {
      className: "input mono",
      attrs: {
        required: true,
        rows: "8",
        spellcheck: "false",
        placeholder: "[Interface]\nPrivateKey = …\nAddress = …\n\n[Peer]\n…",
      },
    });
    const file = h("input", { className: "input", attrs: { type: "file", accept: ".conf,text/plain" } });
    file.addEventListener("change", () => {
      void this.readFile(file);
    });
    this.errors = h("ul", { className: "form-error", attrs: { role: "alert", hidden: true } });
    this.form = h("form", { className: "form" }, [
      h("label", { className: "field" }, [h("span", { text: "Profile name" }), this.name]),
      h("label", { className: "field" }, [h("span", { text: "WireGuard .conf file" }), file]),
      h("label", { className: "field" }, [h("span", { text: "…or paste its contents" }), this.config]),
      h("p", {
        className: "muted small",
        text: "Profiles stay on the server (readable only by Ace Swarm). Hooks such as PostUp are rejected.",
      }),
      this.errors,
      h("div", { className: "form-actions" }, [
        h("button", { className: "button primary", text: "Save profile", attrs: { type: "submit" } }),
      ]),
    ]);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.save();
    });
    shell.body.append(
      h("section", { className: "section" }, [h("h3", { text: "Paths" }), this.strategy, this.paths]),
      h("section", { className: "section" }, [h("h3", { text: "WireGuard profiles" }), this.profiles]),
      h("section", { className: "section" }, [h("h3", { text: "Add a profile" }), this.form]),
    );
  }

  open(snapshot: Snapshot | undefined): void {
    if (snapshot !== undefined) {
      this.update(snapshot);
    }
    this.errors.hidden = true;
    // Open the layer first: it remembers the focused element, and showModal() moves focus.
    this.navigator.open({
      root: this.dialog,
      close: () => {
        this.dialog.close();
      },
    });
    this.dialog.showModal();
    this.navigator.focusFirst(this.dialog);
    void this.loadProfiles();
  }

  update(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    if (!this.dialog.open) {
      return;
    }
    this.strategy.textContent = STRATEGY_LABELS[snapshot.pathStrategy];
    const load = new Map<string, number>();
    for (const stream of snapshot.streams) {
      if (stream.path !== null) {
        load.set(stream.path, (load.get(stream.path) ?? 0) + 1);
      }
    }
    this.paths.replaceChildren(...snapshot.paths.map((path) => this.pathRow(path, load.get(path.id) ?? 0)));
  }

  private pathRow(path: PathStatus, streams: number): HTMLElement {
    const score = Math.round(path.score * 100);
    const details = [
      `RTT ${formatRtt(path.rttMs)}`,
      `loss ${formatLoss(path.loss)}`,
      `${String(streams)} stream${streams === 1 ? "" : "s"}`,
    ];
    if (path.error !== null) {
      details.push(path.error);
    }
    const main = h("div", { className: "row-main" }, [
      h("span", { className: "row-title", text: path.label }),
      h("span", { className: "row-sub", text: details.join(" · ") }),
    ]);
    const bar = h("div", { className: "score-bar", attrs: { style: `width: ${String(score)}%` } });
    return h("li", { className: "row" }, [
      main,
      h("div", { className: "score", attrs: { title: `Score ${String(score)}/100` } }, [bar]),
      h("span", { className: `badge ${path.up ? "state-playing" : "state-error"}`, text: path.up ? "Up" : "Down" }),
    ]);
  }

  private profileRow(profile: WireguardProfileView): HTMLElement {
    const remove = confirmButton("Remove", "Press again to remove", async () => {
      await api.removeProfile(profile.name);
      toast(`Removed ${profile.name}`);
      await this.loadProfiles();
    });
    const summary = [profile.endpoint ?? "no endpoint", ...profile.addresses].join(" · ");
    const main = h("div", { className: "row-main" }, [
      h("span", { className: "row-title", text: profile.name }),
      h("span", { className: "row-sub mono", text: summary }),
    ]);
    return h("li", { className: "row" }, [main, h("div", { className: "row-actions" }, [remove])]);
  }

  private async loadProfiles(): Promise<void> {
    try {
      this.renderProfiles(await api.profiles());
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }

  private renderProfiles(profiles: WireguardProfileView[]): void {
    if (profiles.length === 0) {
      this.profiles.replaceChildren(
        h("li", { className: "muted", text: "No profiles yet: every stream uses the direct path." }),
      );
      return;
    }
    this.profiles.replaceChildren(...profiles.map((profile) => this.profileRow(profile)));
  }

  private async readFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    this.config.value = await file.text();
    if (this.name.value.length === 0) {
      this.name.value = profileName(file.name);
    }
  }

  private async save(): Promise<void> {
    this.errors.hidden = true;
    try {
      const profile = await api.saveProfile(this.name.value.trim(), this.config.value);
      toast(`Saved ${profile.name}`);
      this.form.reset();
      await this.loadProfiles();
      if (this.snapshot !== undefined) {
        this.update(this.snapshot);
      }
    } catch (error) {
      const details = error instanceof ApiError && error.details.length > 0 ? error.details : [errorMessage(error)];
      this.errors.replaceChildren(...details.map((detail) => h("li", { text: detail })));
      this.errors.hidden = false;
    }
  }
}
