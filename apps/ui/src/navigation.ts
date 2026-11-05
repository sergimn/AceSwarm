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

/**
 * The sticky or fixed part of a layer that an element is in, like a dialog's header, or else the
 * layer itself. Such a part stays where it is on screen while the rest scrolls under it.
 */
function stickyPart(element: HTMLElement, root: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node !== null && node !== root; node = node.parentElement) {
    const { position } = getComputedStyle(node);
    if (position === "sticky" || position === "fixed") {
      return node;
    }
  }
  return root;
}

function nearest(from: HTMLElement, candidates: readonly HTMLElement[], direction: Direction): HTMLElement | undefined {
  const boxes = candidates.map((candidate) => toBox(candidate));
  return candidates[pickNext(toBox(from), boxes, direction)];
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
  private lastRestored: HTMLElement | undefined;

  constructor(base: HTMLElement) {
    this.base = base;
    document.addEventListener("keydown", (event) => {
      this.onKey(event);
    });
    addEventListener("popstate", () => {
      this.onPopState();
    });
    document.addEventListener("fullscreenchange", () => {
      this.recoverFocus();
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
    this.lastRestored = layer.restoreFocus instanceof HTMLElement ? layer.restoreFocus : undefined;
    this.recoverFocus(true);
    // Leaving full screen finishes after the layer closed and can drop focus on the document.
    requestAnimationFrame(() => {
      this.recoverFocus();
    });
  }

  /** Puts focus back where it was before the last layer opened, if focus was lost (or always). */
  private recoverFocus(always = false): void {
    const active = document.activeElement;
    // Focus is lost when it sits on the document or still inside a layer that has closed. While an
    // element is full screen, Chromium keeps the rest of the page inert, so the first attempt can
    // fail and this runs again once full screen has ended.
    const lost = active === null || active === document.body || !this.root().contains(active);
    if (!always && !lost) {
      return;
    }
    const target = this.lastRestored;
    if (target?.isConnected === true && this.root().contains(target)) {
      target.focus();
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
    // Elements that scroll with the focused one come first. Otherwise, in a scrolled dialog, its
    // sticky header would be nearer than what scrolled out of view under it.
    const part = stickyPart(current, root);
    const scrollingTogether = others.filter((item) => stickyPart(item, root) === part);
    const next = nearest(current, scrollingTogether, direction) ?? nearest(current, others, direction);
    if (next === undefined) {
      return;
    }

    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
