import type { AceIdListEntry } from "@aceswarm/shared/ace-id-list";
import type { BulkAddResponse, BulkAddResult } from "@aceswarm/shared/api-types";

/** How many line numbers or stream names a sentence lists before it says "and N more". */
const LISTED = 5;

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** "a, b and c", and "a, b, c, d, e and 3 more" for a long list. */
function listOf(items: readonly string[]): string {
  const shown = items.slice(0, LISTED);
  const more = items.length - shown.length;
  if (more > 0) {
    return `${shown.join(", ")} and ${String(more)} more`;
  }
  const last = shown.pop();
  return shown.length === 0 ? (last ?? "") : `${shown.join(", ")} and ${last ?? ""}`;
}

/** How many streams a list would add: each identifier once. */
export function streamCount(entries: readonly AceIdListEntry[]): number {
  return entries.filter((entry) => entry.ace !== undefined && entry.repeats === undefined).length;
}

/** What the Add button says for a list with that many streams. */
export function submitLabel(count: number): string {
  return count === 0 ? "Add streams" : `Add ${plural(count, "stream", "streams")}`;
}

/** What a list holds, said under its box while it is typed or pasted. */
export function listSummary(entries: readonly AceIdListEntry[]): string {
  const parts = [`${plural(streamCount(entries), "stream", "streams")} found.`];
  const invalid = entries.filter((entry) => entry.ace === undefined).map((entry) => String(entry.line));
  if (invalid.length > 0) {
    parts.push(`No Acestream ID or infohash on ${invalid.length === 1 ? "line" : "lines"} ${listOf(invalid)}.`);
  }
  const repeated = entries.filter((entry) => entry.repeats !== undefined).length;
  if (repeated > 0) {
    parts.push(`${plural(repeated, "line repeats", "lines repeat")} a stream above.`);
  }
  return parts.join(" ");
}

function added(response: BulkAddResponse, enabled: boolean): string {
  return `Added ${plural(response.added, "stream", "streams")}${enabled ? "" : ", disabled"}.`;
}

/** The streams of a list that were in the stream list before it was sent. */
function alreadyThere(results: readonly BulkAddResult[]): BulkAddResult[] {
  return results.filter((result) => result.status === "duplicate" && result.repeatsLine === null);
}

/** What the toast says once a list was added and nothing of it is left to correct. */
export function addedToast(response: BulkAddResponse, enabled: boolean): string {
  const existing = alreadyThere(response.results).length;
  return existing === 0
    ? added(response, enabled)
    : `${added(response, enabled)} ${plural(existing, "was", "were")} already in the list.`;
}

/**
 * What became of a list that was sent, a sentence for each kind of result: the dialog shows them
 * when lines are left to correct, or when nothing was added.
 */
export function resultLines(response: BulkAddResponse, enabled: boolean): string[] {
  const lines = [response.added > 0 ? added(response, enabled) : "No stream was added."];
  const existing = alreadyThere(response.results);
  if (existing.length > 0) {
    const names = existing.map((result) => result.stream?.name ?? result.aceId ?? result.text);
    lines.push(`${plural(existing.length, "was", "were")} already in the list: ${listOf(names)}.`);
  }
  const repeated = response.results.filter((result) => result.repeatsLine !== null).length;
  if (repeated > 0) {
    lines.push(`${plural(repeated, "line repeats", "lines repeat")} a stream above.`);
  }
  if (response.invalid > 0) {
    lines.push(
      response.invalid === 1
        ? "1 line has no Acestream ID or infohash. It is still in the box, to correct or remove."
        : `${String(response.invalid)} lines have no Acestream ID or infohash. They are still in the box, to correct or remove.`,
    );
  }
  return lines;
}

/** The lines of a sent list that have no stream, for the box to keep: the ones left to correct. */
export function leftoverText(text: string, results: readonly BulkAddResult[]): string {
  const invalid = new Set(results.filter((result) => result.status === "invalid").map((result) => result.line));
  return text
    .split(/\r\n|\r|\n/)
    .filter((_line, index) => invalid.has(index + 1))
    .join("\n");
}
