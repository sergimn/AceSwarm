import type { Snapshot, StreamView } from "@aceswarm/shared/api-types";
import { h } from "./dom.ts";
import {
  countryName,
  formatFreshness,
  formatPeers,
  formatSpeed,
  isFresh,
  pathLabel,
  STATE_LABELS,
  topCountries,
} from "./format.ts";
import type { PreviewManager } from "./previews.ts";

const THUMBNAIL_REFRESH_MS = 10_000;
const PREVIEW_STATES = new Set(["playing", "buffering", "stalled", "recovering", "switching"]);

function statRow(label: string, value: HTMLElement): HTMLElement {
  return h("div", { className: "stat" }, [h("span", { className: "stat-label", text: label }), value]);
}

class Tile {
  readonly element: HTMLButtonElement;
  readonly video: HTMLVideoElement;
  private readonly poster: HTMLImageElement;
  private readonly name: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly path: HTMLElement;
  private readonly freshness: HTMLElement;
  private readonly peers: HTMLElement;
  private readonly countries: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly message: HTMLElement;
  private thumbnailTick = -1;
  private countryKey = "";

  constructor(stream: StreamView, onOpen: (id: string) => void) {
    this.video = h("video", {
      className: "tile-video",
      attrs: { muted: true, playsinline: true, "aria-hidden": "true" },
    });
    this.poster = h("img", { className: "tile-poster", attrs: { alt: "", loading: "lazy", decoding: "async" } });
    this.poster.addEventListener("error", () => {
      this.poster.classList.add("missing");
    });
    this.poster.addEventListener("load", () => {
      this.poster.classList.remove("missing");
    });
    this.video.addEventListener("playing", () => {
      this.element.classList.add("has-video");
    });
    this.video.addEventListener("emptied", () => {
      this.element.classList.remove("has-video");
    });
    this.name = h("span", { className: "tile-name" });
    this.badge = h("span", { className: "badge" });
    this.path = h("span", { className: "badge path" });
    this.freshness = h("span", { className: "stat-value" });
    this.peers = h("span", { className: "stat-value" });
    this.countries = h("span", { className: "stat-value flags" });
    this.speed = h("span", { className: "stat-value" });
    this.message = h("p", { className: "tile-message" });
    this.element = h("button", { className: "tile", attrs: { type: "button", "data-stream": stream.id } }, [
      h("div", { className: "tile-media" }, [h("div", { className: "tile-placeholder" }), this.poster, this.video]),
      h("div", { className: "tile-top" }, [this.badge, this.path]),
      h("div", { className: "tile-bottom" }, [this.name]),
      h("div", { className: "tile-stats" }, [
        statRow("Freshness", this.freshness),
        statRow("Peers", this.peers),
        statRow("Countries", this.countries),
        statRow("Download", this.speed),
        this.message,
      ]),
    ]);
    this.element.addEventListener("click", () => {
      onOpen(stream.id);
    });
  }

  update(stream: StreamView, snapshot: Snapshot, now: number): void {
    const state = stream.enabled ? stream.state : "stopped";
    this.element.dataset["state"] = state;
    this.element.setAttribute("aria-label", `${stream.name}, ${STATE_LABELS[state]}`);
    this.name.textContent = stream.name;
    this.badge.textContent = STATE_LABELS[state];
    this.badge.className = `badge state-${state}`;
    this.path.textContent = pathLabel(stream.path, snapshot.paths);
    this.path.hidden = stream.path === null;

    this.freshness.textContent = formatFreshness(stream.lastFrameAt, now);
    this.freshness.classList.toggle("fresh", isFresh(stream.lastFrameAt, now));
    this.peers.textContent = formatPeers(stream.peers);
    this.speed.textContent = formatSpeed(stream.downloadKBps);
    this.message.textContent = stream.message ?? "";
    this.message.hidden = stream.message === null;
    this.renderCountries(stream);

    const tick = Math.floor(now / THUMBNAIL_REFRESH_MS);
    if (tick === this.thumbnailTick || state === "stopped") {
      return;
    }

    this.thumbnailTick = tick;
    this.poster.src = `${stream.hls.thumbnail}?t=${String(tick)}`;
  }

  private renderCountries(stream: StreamView): void {
    const top = topCountries(stream.peers.countries);
    const key = top.map((country) => `${country.code}:${String(country.count)}`).join(",");
    if (key === this.countryKey) {
      return;
    }
    this.countryKey = key;
    if (top.length === 0) {
      this.countries.replaceChildren("–");
      return;
    }
    this.countries.replaceChildren(
      ...top.map((country) =>
        h(
          "span",
          { className: "country", attrs: { title: `${countryName(country.code)}: ${String(country.count)}` } },
          [
            h("span", { className: `fi fi-${country.code.toLowerCase()}`, attrs: { "aria-hidden": "true" } }),
            h("span", { className: "country-code", text: country.code }),
          ],
        ),
      ),
    );
  }
}

/** The home screen grid: one tile per stream, kept in sync with the live snapshot. */
export class Grid {
  private readonly container: HTMLElement;
  private readonly previews: PreviewManager;
  private readonly onOpen: (id: string) => void;
  private readonly tiles = new Map<string, Tile>();

  constructor(container: HTMLElement, previews: PreviewManager, onOpen: (id: string) => void) {
    this.container = container;
    this.previews = previews;
    this.onOpen = onOpen;
  }

  get size(): number {
    return this.tiles.size;
  }

  firstTile(): HTMLElement | undefined {
    return this.container.querySelector<HTMLElement>(".tile") ?? undefined;
  }

  render(snapshot: Snapshot, now: number): void {
    const seen = new Set<string>();
    let previous: Element | null = null;
    for (const stream of snapshot.streams) {
      seen.add(stream.id);
      let tile = this.tiles.get(stream.id);
      if (tile === undefined) {
        tile = new Tile(stream, this.onOpen);
        this.tiles.set(stream.id, tile);
        this.previews.register(tile.video, stream.hls.preview);
      }
      tile.update(stream, snapshot, now);
      this.previews.setWanted(tile.video, stream.enabled && PREVIEW_STATES.has(stream.state));
      // Keep DOM order equal to the snapshot order without moving nodes that are already placed
      // (moving the focused tile would drop focus).
      const expected: Element | null =
        previous === null ? this.container.firstElementChild : previous.nextElementSibling;
      if (expected !== tile.element) {
        if (previous === null) {
          this.container.prepend(tile.element);
        } else {
          previous.after(tile.element);
        }
      }
      previous = tile.element;
    }
    for (const [id, tile] of this.tiles) {
      if (!seen.has(id)) {
        this.previews.unregister(tile.video);
        tile.element.remove();
        this.tiles.delete(id);
      }
    }
  }
}
