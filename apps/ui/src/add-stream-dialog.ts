import { api, ApiError } from "./api.ts";
import { dialogShell, errorMessage, h, toast } from "./dom.ts";
import type { Navigator } from "./navigation.ts";

/** Dialog to add a stream by Acestream ID or `acestream://` link. */
export class AddStreamDialog {
  private readonly navigator: Navigator;
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private readonly aceId: HTMLInputElement;
  private readonly name: HTMLInputElement;
  private readonly error: HTMLElement;

  constructor(navigator: Navigator) {
    this.navigator = navigator;
    const shell = dialogShell("Add stream", () => {
      this.navigator.back();
    });
    this.dialog = shell.dialog;
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
    this.name = h("input", { className: "input", attrs: { name: "name", maxlength: "80", placeholder: "Optional" } });
    this.error = h("p", { className: "form-error", attrs: { role: "alert", hidden: true } });
    const cancel = h("button", { className: "button", text: "Cancel", attrs: { type: "button" } });
    cancel.addEventListener("click", () => {
      this.navigator.back();
    });
    this.form = h("form", { className: "form" }, [
      h("label", { className: "field" }, [h("span", { text: "Acestream ID or infohash" }), this.aceId]),
      h("label", { className: "field" }, [h("span", { text: "Name" }), this.name]),
      this.error,
      h("div", { className: "form-actions" }, [
        cancel,
        h("button", { className: "button primary", text: "Add stream", attrs: { type: "submit" } }),
      ]),
    ]);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    shell.body.append(this.form);
  }

  open(): void {
    this.form.reset();
    this.error.hidden = true;
    this.dialog.showModal();
    this.navigator.open({
      root: this.dialog,
      close: () => {
        this.dialog.close();
      },
    });
    this.aceId.focus();
  }

  private async submit(): Promise<void> {
    const submit = this.form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit !== null) {
      submit.disabled = true;
    }
    try {
      const stream = await api.addStream(this.aceId.value.trim(), this.name.value.trim());
      toast(`Added ${stream.name}`);
      this.navigator.back();
    } catch (error) {
      this.error.textContent =
        error instanceof ApiError && error.status === 409 ? "That stream is already in the list." : errorMessage(error);
      this.error.hidden = false;
    } finally {
      if (submit !== null) {
        submit.disabled = false;
      }
    }
  }
}
