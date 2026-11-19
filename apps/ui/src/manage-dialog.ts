import type { Snapshot, StreamView } from "@aceswarm/shared/api-types";
import { api } from "./api.ts";
import { confirmButton, dialogShell, errorMessage, h, icon, toast } from "./dom.ts";
import { shownState, STATE_LABELS } from "./format.ts";
import type { Navigator } from "./navigation.ts";

const KIND_LABELS = { "content-id": " · content ID", infohash: " · infohash", unknown: "" } as const;

/**
 * How long a row's Restart, Disable and Enable ignore presses after Enable took the place of the
 * other two, or gave it back. The new button appears under the pointer and takes the focus, so the
 * second half of a double press would land on it and undo the first.
 */
const SWAP_SETTLE_MS = 500;

interface Row {
  element: HTMLElement;
  name: HTMLElement;
  identifier: HTMLElement;
  state: HTMLElement;
  /** Restart and Disable, and the one Enable button that takes their place while the stream is disabled. */
  pair: HTMLElement;
  restart: HTMLButtonElement;
  disable: HTMLButtonElement;
  enable: HTMLButtonElement;
  /** When the pair last changed between its two looks (see `SWAP_SETTLE_MS`). */
  swap: { at: number };
}

/** Lists every stream with restart, enable/disable and remove actions. */
export class ManageDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly rows = new Map<string, Row>();

  constructor(navigator: Navigator) {
    this.navigator = navigator;
    const shell = dialogShell("Streams", () => {
      this.navigator.back();
    });
    this.dialog = shell.dialog;
    this.list = h("ul", { className: "rows" });
    this.empty = h("p", { className: "muted", text: "No streams yet." });
    shell.body.append(this.list, this.empty);
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
    const seen = new Set<string>();
    for (const stream of snapshot.streams) {
      seen.add(stream.id);
      let row = this.rows.get(stream.id);
      if (row === undefined) {
        row = this.createRow(stream);
        this.rows.set(stream.id, row);
        this.list.append(row.element);
      }
      this.renderRow(row, stream);
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.element.remove();
        this.rows.delete(id);
      }
    }
    this.empty.hidden = this.rows.size > 0;
  }

  private renderRow(row: Row, stream: StreamView): void {
    row.name.textContent = stream.name;
    row.identifier.textContent = `${stream.aceId}${KIND_LABELS[stream.aceIdKind ?? "unknown"]}`;
    const state = shownState(stream);
    row.state.textContent = STATE_LABELS[state];
    row.state.className = `badge state-${state}`;
    // A disabled stream has nothing to restart, and enabling it starts it afresh: one Enable
    // button takes the place of Restart and Disable, so every button a remote lands on does
    // something. Focus follows to the button that is there now.
    const focused = document.activeElement;
    if (row.enable.hidden !== stream.enabled) {
      row.swap.at = performance.now();
    }
    row.pair.classList.toggle("single", !stream.enabled);
    row.enable.hidden = stream.enabled;
    if (!stream.enabled && (focused === row.restart || focused === row.disable)) {
      row.enable.focus();
    } else if (stream.enabled && focused === row.enable) {
      row.disable.focus();
    }
  }

  private createRow(stream: StreamView): Row {
    const name = h("span", { className: "row-title" });
    const state = h("span", { className: "badge" });
    const swap = { at: -Infinity };
    const settled = (): boolean => performance.now() - swap.at >= SWAP_SETTLE_MS;
    const restart = h("button", { className: "button", attrs: { type: "button" } }, [icon("refresh"), "Restart"]);
    restart.addEventListener("click", () => {
      if (!settled()) {
        return;
      }
      api
        .restartStream(stream.id)
        .then(() => {
          toast("Restarting the stream");
        })
        .catch((error: unknown) => {
          toast(errorMessage(error), "error");
        });
    });
    const setEnabled = (enabled: boolean): void => {
      if (!settled()) {
        return;
      }
      api
        .updateStream(stream.id, { enabled })
        .then((updated) => {
          // Without waiting for the next snapshot: the row shows what the press did.
          const row = this.rows.get(stream.id);
          if (row !== undefined) {
            this.renderRow(row, updated);
          }
        })
        .catch((error: unknown) => {
          toast(errorMessage(error), "error");
        });
    };
    const disable = h("button", { className: "button", text: "Disable", attrs: { type: "button" } });
    disable.addEventListener("click", () => {
      setEnabled(false);
    });
    const enable = h("button", { className: "button", text: "Enable", attrs: { type: "button" } });
    enable.hidden = stream.enabled;
    enable.addEventListener("click", () => {
      setEnabled(true);
    });
    // Restart and Disable stay in the layout while Enable lies over them, so it is exactly as wide
    // as the two together and Remove stays where it is (see `.row-pair` in the styles).
    const pair = h("div", { className: "row-pair" }, [
      h("div", { className: "row-pair-buttons" }, [restart, disable]),
      enable,
    ]);
    // A held OK or Enter key repeats, and each repeat would press whichever button is there by then.
    pair.addEventListener("keydown", (event) => {
      if (event.repeat && event.key === "Enter") {
        event.preventDefault();
      }
    });
    const remove = confirmButton("Remove", "Press again to remove", async () => {
      await api.removeStream(stream.id);
      toast("Stream removed");
    });
    const identifier = h("span", { className: "row-sub mono", text: stream.aceId });
    const element = h("li", { className: "row" }, [
      h("div", { className: "row-main" }, [name, identifier]),
      state,
      h("div", { className: "row-actions" }, [pair, remove]),
    ]);
    return { element, name, identifier, state, pair, restart, disable, enable, swap };
  }
}
