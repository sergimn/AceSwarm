type Child = Node | string | null | undefined | false;

export interface ElementOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string | boolean | undefined>;
}

/** Small element builder; text always goes through textContent, never innerHTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className !== undefined) {
    element.className = options.className;
  }
  if (options.text !== undefined) {
    element.textContent = options.text;
  }
  const attributes = Object.entries(options.attrs ?? {});
  for (const [name, value] of attributes) {
    if (value === true) {
      element.setAttribute(name, "");
    } else if (typeof value === "string") {
      element.setAttribute(name, value);
    }
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      element.append(child);
    }
  }
  return element;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** Inline SVG icon built from the static paths above. */
export function icon(name: IconName): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}

/**
 * A button that asks for a second press before running a destructive action. Remote controls
 * have no hover or modifier keys, so this replaces a confirmation dialog.
 */
export function confirmButton(
  label: string,
  confirmLabel: string,
  onConfirm: () => Promise<void>,
  className = "button danger",
): HTMLButtonElement {
  const button = h("button", { className, text: label, attrs: { type: "button" } });
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    armed = false;
    button.textContent = label;
    button.classList.remove("armed");
  };
  button.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      button.textContent = confirmLabel;
      button.classList.add("armed");
      timer = setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(timer);
    disarm();
    button.disabled = true;
    onConfirm()
      .catch((error: unknown) => {
        toast(error instanceof Error ? error.message : String(error), "error");
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  button.addEventListener("blur", disarm);
  return button;
}

export function toast(message: string, kind: "info" | "error" = "info"): void {
  const toastRoot = document.querySelector<HTMLElement>("#toasts") ?? document.body;
  const element = h("div", {
    className: `toast ${kind}`,
    text: message,
    attrs: { role: kind === "error" ? "alert" : "status" },
  });
  toastRoot.append(element);
  setTimeout(() => {
    element.remove();
  }, 5000);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens a modal dialog as a navigation layer; closing goes back through the history. */
export interface DialogShell {
  dialog: HTMLDialogElement;
  body: HTMLElement;
}

export function dialogShell(title: string, onClose: () => void): DialogShell {
  const body = h("div", { className: "dialog-body" });
  const closeButton = h("button", { className: "icon-button", attrs: { type: "button", "aria-label": "Close" } }, [
    icon("close"),
  ]);
  closeButton.addEventListener("click", onClose);
  const dialog = h("dialog", { className: "dialog", attrs: { "aria-label": title } }, [
    h("header", { className: "dialog-header" }, [h("h2", { text: title }), closeButton]),
    body,
  ]);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    onClose();
  });
  document.body.append(dialog);
  return { dialog, body };
}
