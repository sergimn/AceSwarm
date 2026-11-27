/**
 * Handing a stream to a player outside the page, such as VLC: on Android the page follows a link
 * that asks the system to open the stream in an app, and elsewhere it downloads a small `.m3u`
 * file for the computer's player to open.
 */

/** How a stream was handed over, with the address of its playlist. */
export type HandOff =
  /** Android: `link` is the intent link the page followed. */
  | { kind: "app"; url: string; link: string }
  /** Elsewhere: the `.m3u` file the browser downloaded. */
  | { kind: "file"; url: string; fileName: string; content: string };

/** The whole address of a path on this server, as a player outside the page needs it. */
export function absoluteUrl(path: string, base: string): string {
  return new URL(path, base).href;
}

/** Whether the browser runs on Android (a phone, a tablet or a TV), going by its User-Agent. */
export function isAndroid(userAgent: string): boolean {
  return /\bandroid\b/i.test(userAgent);
}

/**
 * An Android intent link for the address of an HLS playlist: it asks the system to open the
 * playlist in an app, and names none, so that the system can offer the players that are installed
 * or open the one set as the default. What a browser and Android do with it was not tried on a
 * real device yet (see "External players" in `docs/architecture.md`).
 */
export function androidIntentUrl(url: string): string {
  const { protocol, host, pathname, search } = new URL(url);
  const scheme = protocol.slice(0, -1);
  return `intent://${host}${pathname}${search}#Intent;scheme=${scheme};action=android.intent.action.VIEW;type=application/vnd.apple.mpegurl;end`;
}

/**
 * A name on one line: control characters become spaces, and so do the two separators that are line
 * breaks to whoever reads a file by Unicode's rules (U+2028 and U+2029).
 */
function oneLine(name: string): string {
  return name.replaceAll(/[\p{Cc}\u{2028}\u{2029}]+/gu, " ").trim();
}

/** The longest name a downloaded file gets, before its extension. */
const FILE_NAME_LENGTH = 80;

/** The downloaded file's name: the stream's name without what file systems refuse, and `.m3u`. */
export function m3uFileName(name: string): string {
  const safe = oneLine(name.replaceAll(/[<>:"/\\|?*]+/g, " "))
    .replaceAll(/\s+/g, " ")
    // A name that starts with a dot is a hidden file on Linux and macOS.
    .replace(/^[. ]+/, "");
  // Cut by code point: half a surrogate pair would make a name no file system takes, while an
  // emoji made of several code points only loses a part.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const short = [...safe].slice(0, FILE_NAME_LENGTH).join("").trim();
  return `${short.length > 0 ? short : "stream"}.m3u`;
}

/** An `.m3u` playlist with one entry: the stream, under its name. */
export function m3uPlaylist(name: string, url: string): string {
  return `#EXTM3U\n#EXTINF:-1,${oneLine(name)}\n${url}\n`;
}

/** How to hand a stream over in this browser: through an app on Android, as a file elsewhere. */
export function handOffFor(name: string, url: string, userAgent: string): HandOff {
  return isAndroid(userAgent)
    ? { kind: "app", url, link: androidIntentUrl(url) }
    : { kind: "file", url, fileName: m3uFileName(name), content: m3uPlaylist(name, url) };
}

/**
 * What the player says once it handed its stream over, where its picture was. A browser hides its
 * downloads while the page is full screen, so the line names the file and where to find it.
 * The address is there to type or copy by hand where nothing else works.
 */
export function handOffMessage(handOff: HandOff, fullscreen: boolean): { title: string; reason: string } {
  const title = "Sent to an external player";
  if (handOff.kind === "app") {
    return {
      title,
      reason: `Pick a player if your device asks for one.\nIf none opens, open this address in your player: ${handOff.url}`,
    };
  }
  const leave = fullscreen ? " Leave full screen to see them." : "";
  return {
    title,
    reason: `Open "${handOff.fileName}" from your browser's downloads to start it.${leave}\nOr open this address in your player: ${handOff.url}`,
  };
}

/** How long the downloaded file's data stays around for the browser to save it. */
const DOWNLOAD_MS = 60_000;

/**
 * Hands the stream over: follows the intent link, or downloads the file. The link goes inside
 * `host`, the screen on top: while an element is full screen, the rest of the page is inert.
 */
export function openExternally(handOff: HandOff, host: HTMLElement): void {
  const link = document.createElement("a");
  link.hidden = true;
  if (handOff.kind === "app") {
    link.href = handOff.link;
  } else {
    const data = URL.createObjectURL(new Blob([handOff.content], { type: "audio/x-mpegurl" }));
    link.href = data;
    link.download = handOff.fileName;
    setTimeout(() => {
      URL.revokeObjectURL(data);
    }, DOWNLOAD_MS);
  }
  host.append(link);
  link.click();
  link.remove();
}

/** Copies what is selected, and says whether it did. Deprecated, and the only way to copy on plain HTTP. */
function copySelection(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

/**
 * Copies text to the clipboard, and says whether it did. The clipboard API only exists on HTTPS and
 * on localhost, and the app usually runs on plain HTTP in a home network, so the old way (copying
 * what is selected in a text field) is tried too. The field goes inside `host`, as in
 * `openExternally`, and the focus returns to where it was.
 */
export async function copyText(text: string, host: HTMLElement): Promise<boolean> {
  // Typed as always there, but missing on plain HTTP.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Not allowed, by the browser or by the person: the old way may still work.
    }
  }
  const focused = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.className = "copy-field";
  field.setAttribute("aria-hidden", "true");
  host.append(field);
  field.select();
  // Older Safari on iOS is known to select nothing with `select()` alone (not checked here).
  field.setSelectionRange(0, text.length);
  const copied = copySelection();
  field.remove();
  if (focused instanceof HTMLElement) {
    focused.focus();
  }
  return copied;
}
