import { MAX_ACE_ID_LIST_LENGTH, parseAceIdList } from "@aceswarm/shared/ace-id-list";
import { api, ApiError } from "./api.ts";
import {
  leftoverText,
  listSummary,
  listToast,
  MANY_STREAMS,
  resultLines,
  startHint,
  streamCount,
  submitLabel,
} from "./bulk-add.ts";
import { dialogShell, errorMessage, h, switchSetting, toast, type SwitchSetting } from "./dom.ts";
import type { Navigator } from "./navigation.ts";

/** Whether the streams of a list start as soon as they are added, until the switch says otherwise. */
const START_LIST_NOW = true;

const LIST_HINT =
  "One stream per line: content IDs, infohashes, acestream:// or magnet: links. Anything else on a line is ignored.";

/** How many lines of a text say something. */
function countLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * Dialog to add a stream by Acestream ID or `acestream://` link, or several at once from a pasted
 * list with one stream per line.
 */
export class AddStreamDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  /** Turns the dialog into one for a list of streams. */
  private readonly mode: SwitchSetting;
  /** The fields for one stream, and the ones for a list: only one of the two shows. */
  private readonly one: HTMLElement;
  private readonly many: HTMLElement;
  private readonly aceId: HTMLInputElement;
  private readonly name: HTMLInputElement;
  private readonly list: HTMLTextAreaElement;
  /** Says under the list what it holds, while it is typed or pasted. */
  private readonly summary: HTMLElement;
  private readonly start: SwitchSetting;
  private readonly error: HTMLElement;
  /** What became of a list that was sent, when lines are left to correct or nothing was added. */
  private readonly result: HTMLElement;
  private readonly cancel: HTMLButtonElement;
  private readonly submitButton: HTMLButtonElement;
  private several = false;
  /** How many streams the list in the box would add. */
  private count = 0;
  private startNow = START_LIST_NOW;
  private busy = false;
  /** How many times the dialog was opened: an answer that comes after it was closed belongs to an earlier one. */
  private visits = 0;

  constructor(navigator: Navigator) {
    this.navigator = navigator;
    const shell = dialogShell("Add stream", () => {
      this.navigator.back();
    });
    this.dialog = shell.dialog;
    // On the right, under the dialog's close button and above the Add button, so Up and Down reach it.
    this.mode = switchSetting("add-several", "Add several at once", "Paste a list with one stream per line.");
    this.mode.button.addEventListener("click", () => {
      // Not while a request is out: its answer goes to the fields that show now.
      if (!this.busy) {
        this.setSeveral(!this.several);
      }
    });
    this.aceId = h("input", {
      className: "input mono",
      attrs: {
        name: "aceId",
        required: true,
        autocomplete: "off",
        spellcheck: "false",
        placeholder: "Content ID, infohash, acestream:// or magnet: link",
      },
    });
    // A list pasted into the field for one stream is still a list: a single-line field would run
    // its lines together.
    this.aceId.addEventListener("paste", (event) => {
      const pasted = event.clipboardData?.getData("text") ?? "";
      if (this.busy || countLines(pasted) < 2) {
        return;
      }
      event.preventDefault();
      // What is selected is what a paste replaces. The rest of the field goes first, after a list
      // that is in the box already: one typed before the switch was turned back.
      const { value } = this.aceId;
      const typed =
        value.slice(0, this.aceId.selectionStart ?? value.length) +
        value.slice(this.aceId.selectionEnd ?? value.length);
      this.list.value = [this.list.value.trimEnd(), typed.trim(), pasted].filter((part) => part.length > 0).join("\n");
      this.aceId.value = "";
      this.setSeveral(true);
      this.list.focus();
    });
    this.name = h("input", { className: "input", attrs: { name: "name", maxlength: "80", placeholder: "Optional" } });
    this.list = h("textarea", {
      className: "input mono",
      attrs: {
        name: "list",
        rows: "8",
        // A line of the list is a row of the box, however narrow the box is: the lines are told
        // apart by their numbers.
        wrap: "off",
        autocomplete: "off",
        spellcheck: "false",
        "aria-describedby": "add-list-summary",
        placeholder: "acestream://…\nacestream://…\nmagnet:?xt=urn:btih:…",
      },
    });
    this.list.addEventListener("input", () => {
      this.renderList();
    });
    // The box's description, and no live region: it changes with every key.
    this.summary = h("p", { className: "muted small", attrs: { id: "add-list-summary" } });
    this.start = switchSetting("add-start", "Start them right away");
    this.start.button.addEventListener("click", () => {
      this.startNow = !this.startNow;
      this.renderStart();
    });
    this.one = h("div", { className: "form" }, [
      h("label", { className: "field" }, [h("span", { text: "Acestream ID or infohash" }), this.aceId]),
      h("label", { className: "field" }, [h("span", { text: "Name" }), this.name]),
    ]);
    const listField = h("label", { className: "field" }, [
      h("span", { text: "Acestream IDs or infohashes" }),
      this.list,
    ]);
    this.many = h("div", { className: "form", attrs: { hidden: true } }, [
      h("div", { className: "field" }, [listField, this.summary]),
      this.start.element,
    ]);
    this.error = h("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    // It takes focus once it has something to say: a remote scrolls a dialog by moving the focus,
    // and a screen reader reads what gets it.
    this.result = h("div", { className: "form-result", attrs: { role: "status", tabindex: "0", hidden: true } });
    this.cancel = h("button", { className: "button", text: "Cancel", attrs: { type: "button" } });
    this.cancel.addEventListener("click", () => {
      this.navigator.back();
    });
    this.submitButton = h("button", { className: "button primary", text: "Add stream", attrs: { type: "submit" } });
    this.form = h("form", { className: "form" }, [
      this.mode.element,
      this.one,
      this.many,
      this.error,
      this.result,
      h("div", { className: "form-actions" }, [this.cancel, this.submitButton]),
    ]);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    shell.body.append(this.form);
  }

  open(): void {
    // A request of an earlier visit may still be out. Its answer will find another visit and only
    // show a toast, so this one starts free to send its own.
    this.visits++;
    this.setBusy(false);
    this.form.reset();
    this.cancel.textContent = "Cancel";
    this.startNow = START_LIST_NOW;
    this.setSeveral(false);
    // Open the layer first: it remembers the focused element, and showModal() moves focus.
    this.navigator.open({
      root: this.dialog,
      close: () => {
        this.dialog.close();
      },
    });
    this.dialog.showModal();
    this.aceId.focus();
  }

  /** Shows the fields for a list of streams, or the ones for a single stream. */
  private setSeveral(several: boolean): void {
    this.several = several;
    this.mode.show(several);
    this.one.hidden = several;
    this.many.hidden = !several;
    // A hidden field that is required would keep the form from being sent.
    this.aceId.required = !several;
    this.error.hidden = true;
    this.showResult([]);
    // What was typed for one stream is the first line of the list.
    if (several && this.list.value.trim().length === 0 && this.aceId.value.trim().length > 0) {
      this.list.value = this.aceId.value.trim();
    }
    this.renderList();
  }

  private renderList(): void {
    const entries = parseAceIdList(this.list.value);
    this.count = streamCount(entries);
    this.summary.textContent = entries.length === 0 ? LIST_HINT : listSummary(entries);
    this.submitButton.textContent = this.several ? submitLabel(this.count) : "Add stream";
    this.renderStart();
  }

  private renderStart(): void {
    this.start.show(this.startNow);
    this.start.hint.textContent = startHint(this.startNow, this.count);
    this.start.hint.classList.toggle("caution", this.startNow && this.count > MANY_STREAMS);
  }

  /**
   * Shows what became of a list that was sent, a sentence per line, or nothing for no sentences.
   * From the first one on, the button beside Add says Done until the dialog closes: by then
   * streams may be added, and closing the dialog cancels nothing.
   */
  private showResult(sentences: readonly string[]): void {
    this.result.replaceChildren(...sentences.map((sentence) => h("p", { text: sentence })));
    this.result.hidden = sentences.length === 0;
    if (sentences.length > 0) {
      this.cancel.textContent = "Done";
    }
  }

  /**
   * While a request is out the fields can't be changed: its answer rewrites the box or closes the
   * dialog, and what was typed meanwhile would be lost. They are read-only and not disabled, and
   * so is the button: a disabled control drops the focus, and a remote would have nowhere to
   * move from.
   */
  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const field of [this.aceId, this.name, this.list]) {
      field.readOnly = busy;
    }
    for (const button of [this.submitButton, this.mode.button]) {
      button.setAttribute("aria-busy", String(busy));
    }
  }

  private showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  /**
   * Whether the dialog is still open as it was when a request was sent. While the controller
   * restarts an answer can take a while, and the user may have closed the dialog meanwhile, or
   * opened it again: the answer then has no dialog to close and no fields to fill.
   */
  private isVisit(visit: number): boolean {
    return this.dialog.open && visit === this.visits;
  }

  private async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.setBusy(true);
    this.error.hidden = true;
    this.showResult([]);
    const visit = this.visits;
    try {
      await (this.several ? this.addList(visit) : this.addOne(visit));
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 409 ? "That stream is already in the list." : errorMessage(error);
      if (this.isVisit(visit)) {
        this.showError(message);
      } else {
        toast(message, "error");
      }
    } finally {
      // A later visit has a request of its own to wait for, or none.
      if (visit === this.visits) {
        this.setBusy(false);
      }
    }
  }

  private async addOne(visit: number): Promise<void> {
    const text = this.aceId.value.trim();
    if (streamCount(parseAceIdList(text)) > 1) {
      this.showError('This names more than one stream. Turn on "Add several at once" to add them together.');
      return;
    }
    const stream = await api.addStream(text, this.name.value.trim());
    toast(`Added ${stream.name}`);
    if (this.isVisit(visit)) {
      this.navigator.back();
    }
  }

  private async addList(visit: number): Promise<void> {
    const text = this.list.value;
    if (text.length > MAX_ACE_ID_LIST_LENGTH) {
      this.showError(
        `This list is too long: at most ${MAX_ACE_ID_LIST_LENGTH.toLocaleString("en")} characters at a time. Add it in parts.`,
      );
      return;
    }
    if (streamCount(parseAceIdList(text)) === 0) {
      this.showError(
        text.trim().length === 0
          ? "Paste or type a list first, one stream per line."
          : "No line of the list has an Acestream ID or infohash.",
      );
      return;
    }
    const enabled = this.startNow;
    const response = await api.addStreams(text, enabled);
    const open = this.isVisit(visit);
    const done = response.added > 0 && response.invalid === 0;
    // The toast says it when the dialog doesn't: it closes now, or was closed meanwhile.
    if (done || !open) {
      toast(listToast(response, enabled));
    }
    if (!open) {
      return;
    }
    if (done) {
      this.navigator.back();
      return;
    }
    // Lines are left to correct, or nothing was new: the box keeps the lines that are no stream,
    // and the dialog says what became of the rest.
    this.list.value = leftoverText(text, response.results);
    this.renderList();
    this.showResult(resultLines(response, enabled));
    this.result.focus();
  }
}
