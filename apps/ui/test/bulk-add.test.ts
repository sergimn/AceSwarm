import { parseAceIdList } from "@aceswarm/shared/ace-id-list";
import type { BulkAddResponse, BulkAddResult, StreamView } from "@aceswarm/shared/api-types";
import { describe, expect, it } from "vitest";
import {
  leftoverText,
  listSummary,
  listToast,
  MANY_STREAMS,
  resultLines,
  startHint,
  streamCount,
  submitLabel,
} from "../src/bulk-add.ts";

const A = "6d325cda6ed591647ef5e91edd043147bce8be30";
const B = "b146ee4b6e16c9df58e27bd02ffd6cea840ff212";

/** A hex identifier that differs for every number. */
function id(index: number): string {
  return index.toString(16).padStart(40, "0");
}

function result(line: number, status: BulkAddResult["status"], extra: Partial<BulkAddResult> = {}): BulkAddResult {
  const stream = status === "invalid" ? null : ({ name: `Stream ${String(line)}` } as StreamView);
  const aceId = status === "invalid" ? null : id(line);
  return { line, text: `line ${String(line)}`, status, aceId, stream, repeatsLine: null, ...extra };
}

function response(results: BulkAddResult[]): BulkAddResponse {
  const count = (status: BulkAddResult["status"]): number => results.filter((item) => item.status === status).length;
  return { results, added: count("added"), duplicates: count("duplicate"), invalid: count("invalid") };
}

describe("what the dialog says about a list while it is typed", () => {
  it("counts each stream once, and names the button after the count", () => {
    const entries = parseAceIdList(`${A}\nacestream://${B}\n${A}\nnot a stream`);
    expect(streamCount(entries)).toBe(2);
    expect(submitLabel(2)).toBe("Add 2 streams");
    expect(submitLabel(1)).toBe("Add 1 stream");
    expect(submitLabel(0)).toBe("Add streams");
  });

  it("says how many streams it found, which lines have none and how many repeat one", () => {
    expect(listSummary(parseAceIdList(A))).toBe("1 stream found.");
    expect(listSummary(parseAceIdList(`${A}\n${B}`))).toBe("2 streams found.");
    expect(listSummary(parseAceIdList(`${A}\n\nnot a stream`))).toBe(
      "1 stream found. No Acestream ID or infohash on line 3.",
    );
    expect(listSummary(parseAceIdList(`x\n${A}\ny\n${A}\n${A}\n${B}\n${B}`))).toBe(
      "2 streams found. No Acestream ID or infohash on lines 1 and 3. 3 lines repeat a stream above.",
    );
    expect(listSummary(parseAceIdList(`${A}\n${A}\nx\ny\nz`))).toBe(
      "1 stream found. No Acestream ID or infohash on lines 3, 4 and 5. 1 line repeats a stream above.",
    );
    expect(listSummary(parseAceIdList("nothing here"))).toBe("0 streams found. No Acestream ID or infohash on line 1.");
  });

  it("counts the lines that repeat a stream above, not a stream that is twice on one line", () => {
    expect(listSummary(parseAceIdList(`acestream://${A} http://127.0.0.1:6878/ace/getstream?id=${A}`))).toBe(
      "1 stream found.",
    );
    // Line 2 repeats line 1 twice over, and is one line.
    expect(listSummary(parseAceIdList(`${A} ${B}\n${B} ${A} ${A}`))).toBe(
      "2 streams found. 1 line repeats a stream above.",
    );
  });

  it("warns under the start switch when a long list would start together", () => {
    expect(startHint(true, 0)).toBe(
      "On: every stream starts as soon as it is added, and downloads its broadcast from then on.",
    );
    expect(startHint(true, MANY_STREAMS)).toBe(startHint(true, 0));
    expect(startHint(true, MANY_STREAMS + 1)).toBe(
      "On: all 11 streams start together, and each downloads its broadcast from then on. That is a lot at once: turn this off to add them disabled, and enable the ones you want under Streams.",
    );
    expect(startHint(false, 500)).toBe("Off: the streams are added disabled. Enable the ones you want under Streams.");
  });

  it("lists the first lines without a stream, and counts the rest", () => {
    const lines = Array.from({ length: 8 }, (_, index) => `wrong ${String(index)}`).join("\n");
    expect(listSummary(parseAceIdList(lines))).toBe(
      "0 streams found. No Acestream ID or infohash on lines 1, 2, 3, 4, 5 and 3 more.",
    );
  });
});

describe("what the dialog says once a list was sent", () => {
  it("says in a toast what was added, when nothing is left to correct", () => {
    const all = response([result(1, "added"), result(2, "added")]);
    expect(listToast(all, true)).toBe("Added 2 streams.");
    expect(listToast(all, false)).toBe("Added 2 streams, disabled.");
    const some = response([result(1, "added"), result(2, "duplicate"), result(3, "duplicate", { repeatsLine: 1 })]);
    // A line that repeats another is nothing the user needs to hear about.
    expect(listToast(some, true)).toBe("Added 1 stream. 1 was already in the list.");
    const more = response([result(1, "added"), result(2, "duplicate"), result(3, "duplicate")]);
    expect(listToast(more, true)).toBe("Added 1 stream. 2 were already in the list.");
  });

  it("says everything in the toast when the dialog was closed before the answer came", () => {
    const partial = response([result(1, "added"), result(2, "invalid"), result(3, "invalid")]);
    expect(listToast(partial, false)).toBe("Added 1 stream, disabled. 2 lines had no Acestream ID or infohash.");
    const nothing = response([result(1, "duplicate"), result(2, "invalid")]);
    expect(listToast(nothing, true)).toBe(
      "No stream was added. 1 was already in the list. 1 line had no Acestream ID or infohash.",
    );
  });

  it("says a sentence for each kind of result, when lines are left to correct", () => {
    const mixed = response([
      result(1, "added"),
      result(2, "invalid"),
      result(3, "duplicate"),
      result(4, "duplicate", { repeatsLine: 1 }),
      result(5, "added"),
    ]);
    expect(resultLines(mixed, true)).toEqual([
      "Added 2 streams.",
      "1 was already in the list: Stream 3.",
      "1 line repeats a stream above.",
      "1 line has no Acestream ID or infohash. It is still in the box, to correct or remove.",
    ]);
    // A stream that is twice on a line repeats nothing above, and two repeats on a line are one line.
    const twice = response([
      result(1, "added"),
      result(1, "duplicate", { repeatsLine: 1 }),
      result(2, "invalid"),
      result(3, "duplicate", { repeatsLine: 1 }),
      result(3, "duplicate", { repeatsLine: 1 }),
    ]);
    expect(resultLines(twice, true)).toEqual([
      "Added 1 stream.",
      "1 line repeats a stream above.",
      "1 line has no Acestream ID or infohash. It is still in the box, to correct or remove.",
    ]);
    const wrong = response([result(1, "added"), result(2, "invalid"), result(3, "invalid")]);
    expect(resultLines(wrong, false)).toEqual([
      "Added 1 stream, disabled.",
      "2 lines have no Acestream ID or infohash. They are still in the box, to correct or remove.",
    ]);
  });

  it("says that nothing was added, and names the streams that were there already", () => {
    const known = response(Array.from({ length: 7 }, (_, index) => result(index + 1, "duplicate")));
    expect(resultLines(known, true)).toEqual([
      "No stream was added.",
      "7 were already in the list: Stream 1, Stream 2, Stream 3, Stream 4, Stream 5 and 2 more.",
    ]);
    const two = response([result(1, "duplicate"), result(2, "duplicate")]);
    expect(resultLines(two, true)).toEqual([
      "No stream was added.",
      "2 were already in the list: Stream 1 and Stream 2.",
    ]);
  });

  it("keeps the lines without a stream in the box, as they were typed", () => {
    const text = `${A}\r\n  wrong one \n\n${B}\nwrong two`;
    const results = [result(1, "added"), result(2, "invalid"), result(4, "duplicate"), result(5, "invalid")];
    expect(leftoverText(text, results)).toBe("  wrong one \nwrong two");
    expect(leftoverText(text, [result(1, "added"), result(4, "added")])).toBe("");
  });
});
