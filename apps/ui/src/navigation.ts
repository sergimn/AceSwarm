import { isBackKey, keyDirection, pickNext, type Box, type Direction } from "./spatial.ts";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface Layer {
  root: HTMLElement;
  close: () => void;
  /** Called first for every key while the layer is on top; return true when it was handled. */
  onKey?: (event: KeyboardEvent) => boolean;
}

interface OpenLayer extends Layer {
  restoreFocus: Element | null;
}

function toBox(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
}

function isTextField(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }
  return (
    element instanceof HTMLInputElement && !["button", "checkbox", "radio", "file", "submit"].includes(element.type)
  );
}

/** Lets arrows move the caret inside text fields, and leave the field once the caret is at its edge. */
function caretKeepsKey(field: HTMLInputElement | HTMLTextAreaElement, direction: Direction): boolean {
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? 0;
  const multiline = field instanceof HTMLTextAreaElement;
  switch (direction) {
    case "left": {
      return start > 0;
    }
    case "right": {
      return end < field.value.length;
    }
    case "up": {
      return multiline && start > 0;
    }
    case "down": {
      return multiline && end < field.value.length;
    }
  }
}

/**
 * Keyboard and remote navigation. Screens that cover the grid (the player and dialogs) are layers
 * pushed onto the browser history, so the remote's Back button, the browser's back gesture and
 * our own close buttons all go through the same path.
 */
export class Navigator {
  private readonly base: HTMLElement;
  private readonly layers: OpenLayer[] = [];
  private backPending = false;

  constructor(base: HTMLElement) {
    this.base = base;
    document.addEventListener("keydown", (event) => {
      this.onKey(event);
    });
    addEventListener("popstate", () => {
      this.onPopState();
    });
  }

  get depth(): number {
    return this.layers.length;
  }

  open(layer: Layer): void {
    this.layers.push({ ...layer, restoreFocus: document.activeElement });
    history.pushState({ aceswarmLayer: this.layers.length }, "");
  }

  /** Closes the top layer. */
  back(): void {
    if (this.layers.length === 0 || this.backPending) {
      return;
    }
    this.backPending = true;
    history.back();
  }

  focusFirst(root: HTMLElement = this.root()): void {
    const first = this.focusables(root)[0];
    first?.focus();
  }

  private root(): HTMLElement {
    return this.layers[this.layers.length - 1]?.root ?? this.base;
  }

  private focusables(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => isVisible(element));
  }

  private onPopState(): void {
    this.backPending = false;
    const layer = this.layers.pop();
    if (layer === undefined) {
      return;
    }
    layer.close();
    if (layer.restoreFocus instanceof HTMLElement && layer.restoreFocus.isConnected) {
      layer.restoreFocus.focus();
    } else {
      this.focusFirst();
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const top = this.layers[this.layers.length - 1];
    if (top?.onKey?.(event) === true) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    const editing = isTextField(active);
    // Some TV remotes only report the legacy key code for Back.
    // eslint-disable-next-line @typescript-eslint/no-deprecated, unicorn/prefer-keyboard-event-key
    const legacyCode = event.keyCode;
    if (isBackKey(event.key, legacyCode) || (event.key === "Backspace" && !editing)) {
      if (top !== undefined) {
        event.preventDefault();
        this.back();
      }
      return;
    }
    const direction = keyDirection(event.key);
    if (direction === undefined || (editing && caretKeepsKey(active, direction))) {
      return;
    }
    event.preventDefault();
    this.move(direction);
  }

  private move(direction: Direction): void {
    const root = this.root();
    const items = this.focusables(root);
    const active = document.activeElement;
    const current = active instanceof HTMLElement && root.contains(active) && active !== root ? active : undefined;
    if (current === undefined) {
      items[0]?.focus();
      return;
    }
    const others = items.filter((item) => item !== current);
    const next =
      others[
        pickNext(
          toBox(current),
          others.map((item) => toBox(item)),
          direction,
        )
      ];
    if (next === undefined) {
      return;
    }

    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
