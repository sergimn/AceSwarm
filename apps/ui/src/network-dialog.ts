import type { PathStatus, Snapshot, WireguardProfileView } from "@aceswarm/shared/api-types";
import { api, ApiError } from "./api.ts";
import { confirmButton, dialogShell, errorMessage, h, toast } from "./dom.ts";
import { formatLoss, formatRtt } from "./format.ts";
import type { Navigator } from "./navigation.ts";

const STRATEGY_LABELS = {
  "sticky-best": "Sticky: streams stay on their path until it fails, then move to the best one",
  "round-robin": "Round robin: new streams are spread across the paths that are up",
} as const;

const WIREGUARD_ONLY_HINTS = {
  off: "Off: streams may use the direct connection.",
  on: "On: streams never use the direct connection. New streams wait for a WireGuard path if none is up.",
  unavailable: "Add a WireGuard profile first.",
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
  private readonly wireguardOnly: HTMLButtonElement;
  private readonly wireguardOnlyState: HTMLElement;
  private readonly wireguardOnlyHint: HTMLElement;
  private snapshot: Snapshot | undefined;
  /** Number of profiles, once loaded. */
  private profileCount: number | undefined;
  /** WireGuard paths in the last snapshot; a change means profiles were added or removed elsewhere. */
  private wireguardPaths: number | undefined;
  private savingPolicy = false;

  constructor(navigator: Navigator) {
    this.navigator = navigator;
    const shell = dialogShell("Network", () => {
      this.navigator.back();
    });
    this.dialog = shell.dialog;
    this.paths = h("ul", { className: "rows" });
    this.strategy = h("p", { className: "muted" });
    // A switch, not a disabled control: a disabled button can't take focus, and remote users
    // would never reach it to read why it is unavailable. It sits on the right, under the dialog's
    // close button and above the profiles' buttons, so Up and Down reach it.
    this.wireguardOnlyState = h("span", { className: "switch-state", attrs: { "aria-hidden": "true" } });
    this.wireguardOnly = h(
      "button",
      {
        className: "switch",
        attrs: {
          type: "button",
          role: "switch",
          "aria-checked": "false",
          "aria-labelledby": "wireguard-only-label",
          "aria-describedby": "wireguard-only-hint",
        },
      },
      [h("span", { className: "switch-track", attrs: { "aria-hidden": "true" } }), this.wireguardOnlyState],
    );
    this.wireguardOnly.addEventListener("click", () => {
      void this.toggleWireguardOnly();
    });
    this.wireguardOnlyHint = h("p", { className: "muted small", attrs: { id: "wireguard-only-hint" } });
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
    const label = h("span", { className: "row-title", text: "WireGuard only", attrs: { id: "wireguard-only-label" } });
    const wireguardOnlySetting = h("div", { className: "setting" }, [
      h("div", { className: "setting-text" }, [label, this.wireguardOnlyHint]),
      this.wireguardOnly,
    ]);
    shell.body.append(
      h("section", { className: "section" }, [
        h("h3", { text: "Paths" }),
        wireguardOnlySetting,
        this.strategy,
        this.paths,
      ]),
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
    const wireguardPaths = snapshot.paths.filter((path) => path.kind === "wireguard").length;
    if (snapshot.paths.length > 0 && this.wireguardPaths !== undefined && wireguardPaths !== this.wireguardPaths) {
      // Profiles changed, perhaps from another screen: the switch's availability depends on them.
      void this.loadProfiles();
    }
    if (snapshot.paths.length > 0) {
      this.wireguardPaths = wireguardPaths;
    }
    this.renderWireguardOnly();
    const load = new Map<string, number>();
    for (const stream of snapshot.streams) {
      if (stream.path !== null) {
        load.set(stream.path, (load.get(stream.path) ?? 0) + 1);
      }
    }
    this.paths.replaceChildren(
      ...snapshot.paths.map((path) => this.pathRow(path, load.get(path.id) ?? 0, snapshot.wireguardOnly)),
    );
  }

  /** WireGuard only can be turned on once a profile exists, and turned off at any time. */
  private renderWireguardOnly(): void {
    const on = this.snapshot?.wireguardOnly ?? false;
    const hasProfiles =
      this.profileCount === undefined
        ? (this.snapshot?.paths.some((path) => path.kind === "wireguard") ?? false)
        : this.profileCount > 0;
    const available = on || hasProfiles;
    this.wireguardOnly.setAttribute("aria-checked", String(on));
    this.wireguardOnly.setAttribute("aria-disabled", String(!available));
    this.wireguardOnlyState.textContent = on ? "On" : "Off";
    let hint: keyof typeof WIREGUARD_ONLY_HINTS = "unavailable";
    if (on) {
      hint = "on";
    } else if (available) {
      hint = "off";
    }
    this.wireguardOnlyHint.textContent = WIREGUARD_ONLY_HINTS[hint];
  }

  private async toggleWireguardOnly(): Promise<void> {
    if (this.savingPolicy) {
      return;
    }
    if (this.wireguardOnly.getAttribute("aria-disabled") === "true") {
      toast(WIREGUARD_ONLY_HINTS.unavailable, "error");
      return;
    }
    const wanted = this.wireguardOnly.getAttribute("aria-checked") !== "true";
    this.savingPolicy = true;
    this.wireguardOnly.setAttribute("aria-busy", "true");
    try {
      const policy = await api.setNetworkPolicy({ wireguardOnly: wanted });
      if (this.snapshot !== undefined) {
        this.update({ ...this.snapshot, wireguardOnly: policy.wireguardOnly });
      }
      toast(policy.wireguardOnly ? "WireGuard only is on" : "WireGuard only is off");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      this.savingPolicy = false;
      this.wireguardOnly.removeAttribute("aria-busy");
    }
  }

  private pathRow(path: PathStatus, streams: number, wireguardOnly: boolean): HTMLElement {
    const score = Math.round(path.score * 100);
    const details = [
      `RTT ${formatRtt(path.rttMs)}`,
      `loss ${formatLoss(path.loss)}`,
      `${String(streams)} stream${streams === 1 ? "" : "s"}`,
    ];
    const off = wireguardOnly && path.kind === "direct";
    if (off) {
      details.push("not used: WireGuard only is on");
    }
    if (path.error !== null) {
      details.push(path.error);
    }
    const main = h("div", { className: "row-main" }, [
      h("span", { className: "row-title", text: path.label }),
      h("span", { className: "row-sub", text: details.join(" · ") }),
    ]);
    const bar = h("div", { className: "score-bar", attrs: { style: `width: ${String(score)}%` } });
    let badge: { className: string; text: string } = { className: "state-stopped", text: "Off" };
    if (!off) {
      badge = path.up ? { className: "state-playing", text: "Up" } : { className: "state-error", text: "Down" };
    }
    return h("li", { className: "row" }, [
      main,
      h("div", { className: "score", attrs: { title: `Score ${String(score)}/100` } }, [bar]),
      h("span", { className: `badge ${badge.className}`, text: badge.text }),
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
    this.profileCount = profiles.length;
    this.renderWireguardOnly();
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
