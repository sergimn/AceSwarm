/**
 * Reads a list of streams as people paste it: one stream per line, with whatever came along from
 * the page, chat or playlist it was copied from. Every line is searched for an identifier, and the
 * rest of the line is ignored.
 */

import { parseAceId, type ParsedAceId } from "./ace-id.ts";

/** The longest list read at once, in characters: room for over two thousand bare identifiers. */
export const MAX_ACE_ID_LIST_LENGTH = 100_000;

export interface AceIdListEntry {
  /** The line of the list the entry is on, counted from 1. */
  line: number;
  /** That line, without the space around it. */
  text: string;
  /** The identifier found, or undefined when the line has none. */
  ace: ParsedAceId | undefined;
  /** The line of the first entry with the same identifier, when this one repeats it. */
  repeats: number | undefined;
}

const HEX_ID = /^[0-9a-f]{40}$/i;
/** What lists put around an identifier or a link: quotes, brackets, and the comma or stop after it. */
const WRAPPING = new Set("\"'`<>()[]{},;.");

/**
 * `text` without the characters of `set` at its ends. A loop and not a pattern like `/[,;]+$/`,
 * which takes time quadratic in the length of a run that isn't at the end.
 */
function trimSet(text: string, set: ReadonlySet<string>): string {
  let start = 0;
  let end = text.length;
  while (start < end && set.has(text.charAt(start))) {
    start++;
  }
  while (end > start && set.has(text.charAt(end - 1))) {
    end--;
  }
  return text.slice(start, end);
}

/**
 * The 40 character hex values inside a piece of a line that isn't an identifier or a link by
 * itself, such as `Sports:acestream://<id>`, `<id>,<id>` or `infohash=<id>`.
 */
function scanPiece(piece: string): ParsedAceId[] {
  // A link that is the value of another link's parameter has its punctuation escaped, as in
  // `?url=acestream%3A%2F%2F<id>`. An escape ends what is before it, as the character it stands for
  // would; `%3D` is the `=` of a parameter.
  const text = piece.replaceAll(/%[0-9a-f]{2}/gi, (escape) => (escape.toLowerCase() === "%3d" ? "=" : " "));
  const found: ParsedAceId[] = [];
  for (const run of text.matchAll(/[0-9a-z]+/gi)) {
    if (!HEX_ID.test(run[0])) {
      continue;
    }
    // The parameter it is the value of says which kind it is, as in an engine's URL.
    const before = text.slice(Math.max(0, run.index - 12), run.index).toLowerCase();
    const parameter = /(?:^|[^0-9a-z_])(infohash|content_id|id)=$/.exec(before)?.[1];
    const kind = parameter === undefined ? null : parameter === "infohash" ? "infohash" : "content-id";
    found.push({ id: run[0].toLowerCase(), kind });
  }
  return found;
}

/** Every identifier in a line. */
function findIds(line: string): ParsedAceId[] {
  const found: ParsedAceId[] = [];
  for (const [piece] of line.matchAll(/\S+/g)) {
    const core = trimSet(piece, WRAPPING);
    // First as a single stream is read: an identifier, a link, a URL that says which kind it is.
    const whole = parseAceId(core);
    if (whole !== undefined) {
      found.push(whole);
      continue;
    }
    const magnet = core.search(/magnet:/i);
    if (magnet === -1) {
      found.push(...scanPiece(piece));
      continue;
    }
    // A magnet link's stream is its `btih` value and nothing else in it (its name can hold a hash
    // too), wherever in the piece the link starts: `[Sports](magnet:?…)`.
    found.push(...scanPiece(core.slice(0, magnet)));
    const link = parseAceId(core.slice(magnet));
    if (link !== undefined) {
      found.push(link);
    }
  }
  return found;
}

/**
 * Reads a pasted list of streams, one per line. A line can be untidy: a bare identifier, an
 * `acestream://` or magnet link or an engine URL, with quotes, commas, a list bullet, a number or
 * any other text around it (`Sports 1 - acestream://…`). Only the identifier counts. Blank lines
 * are skipped.
 *
 * In an M3U playlist (a text with an `#EXT…` line) every line that starts with `#` is skipped: its
 * directives, whatever their attributes hold, and its comments, also a stream that was commented
 * out. In any other list such a line is read like the rest (`#1 <id>`), and skipped when it has no
 * identifier.
 *
 * Returns an entry for every identifier found, in order, and one without an identifier for every
 * other line that says something. A line with several identifiers gives an entry for each.
 */
export function parseAceIdList(text: string): AceIdListEntry[] {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim());
  const playlist = lines.some((line) => /^#EXT/i.test(line));
  const entries: AceIdListEntry[] = [];
  const firsts = new Map<string, AceIdListEntry>();
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      continue;
    }
    const lineNumber = index + 1;
    const comment = line.startsWith("#");
    const found = playlist && comment ? [] : findIds(line);
    if (found.length === 0 && !comment) {
      entries.push({ line: lineNumber, text: line, ace: undefined, repeats: undefined });
    }
    for (const ace of found) {
      const first = firsts.get(ace.id);
      const entry: AceIdListEntry = { line: lineNumber, text: line, ace, repeats: first?.line };
      if (first === undefined) {
        firsts.set(ace.id, entry);
      } else if (first.ace?.kind === null && ace.kind !== null) {
        // A repeat that says which kind the identifier is says it for the first one too.
        first.ace = { id: ace.id, kind: ace.kind };
      }
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * The one stream a text names, read as a line of a list is, or undefined when it names none or
 * several. For a single stream typed or pasted with something around it.
 */
export function parseAceIdText(text: string): ParsedAceId | undefined {
  const [entry, ...others] = parseAceIdList(text);
  return others.length === 0 ? entry?.ace : undefined;
}
