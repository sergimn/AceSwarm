import { describe, expect, it } from "vitest";
import { parseAceIdList, parseAceIdText } from "../src/ace-id-list.ts";

const A = "6d325cda6ed591647ef5e91edd043147bce8be30";
const B = "b146ee4b6e16c9df58e27bd02ffd6cea840ff212";
const C = "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567";

/** What a list gives, without the text of its lines. */
function read(text: string): unknown[] {
  return parseAceIdList(text).map(({ line, ace, repeats }) => ({
    line,
    id: ace?.id,
    kind: ace?.kind,
    ...(repeats !== undefined && { repeats }),
  }));
}

describe("parseAceIdList", () => {
  it("reads one stream per line, in every form a single stream is read in", () => {
    const base32 = "aaaqeayeaudaocajbifqydiob4ibceqt";
    const list = [
      A,
      `acestream://${B}`,
      `magnet:?xt=urn:btih:${C}&dn=x`,
      `http://127.0.0.1:6878/ace/getstream?id=${"1".repeat(40)}&pid=1`,
      `http://127.0.0.1:6878/ace/getstream?infohash=${"2".repeat(40)}`,
      `magnet:?xt=urn:btih:${base32}`,
    ].join("\n");
    expect(read(list)).toEqual([
      { line: 1, id: A, kind: null },
      { line: 2, id: B, kind: null },
      { line: 3, id: C, kind: "infohash" },
      { line: 4, id: "1".repeat(40), kind: "content-id" },
      { line: 5, id: "2".repeat(40), kind: "infohash" },
      { line: 6, id: "000102030405060708090a0b0c0d0e0f10111213", kind: "infohash" },
    ]);
  });

  it("counts lines as the pasted text has them, whatever ends them, and skips blank ones", () => {
    expect(read(`\u{FEFF}${A}\r\n\r\n   \r\n${B}\r${C}\n`)).toEqual([
      { line: 1, id: A, kind: null },
      { line: 4, id: B, kind: null },
      { line: 5, id: C, kind: null },
    ]);
    expect(read("")).toEqual([]);
    expect(read(" \n\t\n")).toEqual([]);
  });

  it("finds the identifier in an untidy line, and ignores the rest of the line", () => {
    const untidy = [
      `  ${A.toUpperCase()}  `,
      `"acestream://${A}",`,
      `- ${A}`,
      `3. acestream://${A}`,
      `<acestream://${A}/>`,
      `(${A}).`,
      `'${A}';`,
      `\u{200B}${A}`,
      `ACESTREAM://${A}/`,
      `Sports 1 - acestream://${A}`,
      `acestream://${A}  Sports 1 (HD)`,
      `Sports 1,${A}`,
      `${A};Sports 1`,
      `Sports:acestream://${A}`,
      `Sports\t1\t${A}`,
      `Deportes Ñ 2 | ${A} # sin cortes`,
    ];
    for (const line of untidy) {
      expect(read(line), line).toEqual([{ line: 1, id: A, kind: null }]);
    }
  });

  it("reads the kind where a line says it, also with other text around", () => {
    expect(read(`Sports magnet:?xt=urn:btih:${A}&dn=Some+Name`)).toEqual([{ line: 1, id: A, kind: "infohash" }]);
    expect(read(`Sports "http://127.0.0.1:6878/ace/getstream?id=${A}&pid=1",`)).toEqual([
      { line: 1, id: A, kind: "content-id" },
    ]);
    // A parameter without a link around it.
    expect(read(`infohash=${A}`)).toEqual([{ line: 1, id: A, kind: "infohash" }]);
    expect(read(`Sports id=${A}`)).toEqual([{ line: 1, id: A, kind: "content-id" }]);
    expect(read(`content_id=${A}`)).toEqual([{ line: 1, id: A, kind: "content-id" }]);
    // Not a parameter of that name.
    expect(read(`uuid=${A}`)).toEqual([{ line: 1, id: A, kind: null }]);
    expect(read(`my_id=${A}`)).toEqual([{ line: 1, id: A, kind: null }]);
  });

  it("finds an identifier inside a link no single stream is read from", () => {
    expect(read(`http://proxy.example/pid/${A}/stream.mp4`)).toEqual([{ line: 1, id: A, kind: null }]);
    expect(read(`https://example.com/?q=${A}`)).toEqual([{ line: 1, id: A, kind: null }]);
  });

  it("gives every identifier of a line an entry", () => {
    expect(read(`${A}, ${B} ${C}`)).toEqual([
      { line: 1, id: A, kind: null },
      { line: 1, id: B, kind: null },
      { line: 1, id: C, kind: null },
    ]);
    expect(read(`Both ${A},acestream://${B}`)).toEqual([
      { line: 1, id: A, kind: null },
      { line: 1, id: B, kind: null },
    ]);
  });

  it("gives a line without an identifier an entry too, so it can be reported", () => {
    const entries = parseAceIdList(`${A}\n  not a stream \n${A.slice(1)}\n${A}0\nmagnet:?xt=urn:btih:nothex`);
    expect(entries).toEqual([
      { line: 1, text: A, ace: { id: A, kind: null }, repeats: undefined },
      { line: 2, text: "not a stream", ace: undefined, repeats: undefined },
      // One character short, and one too many.
      { line: 3, text: A.slice(1), ace: undefined, repeats: undefined },
      { line: 4, text: `${A}0`, ace: undefined, repeats: undefined },
      { line: 5, text: "magnet:?xt=urn:btih:nothex", ace: undefined, repeats: undefined },
    ]);
  });

  it("takes nothing but the btih value from a magnet link", () => {
    expect(read(`magnet:?xt=urn:sha1:${A}&dn=x`)).toEqual([{ line: 1, id: undefined, kind: undefined }]);
    expect(read(`"magnet:?dn=${B}&xt=urn:btih:${A}"`)).toEqual([{ line: 1, id: A, kind: "infohash" }]);
    // Also when the link doesn't start its piece of the line.
    expect(read(`[Sports](magnet:?xt=urn:btih:${A}&dn=${B})`)).toEqual([{ line: 1, id: A, kind: "infohash" }]);
    expect(read("Sports:magnet:?xt=urn:btih:aaaqeayeaudaocajbifqydiob4ibceqt")).toEqual([
      { line: 1, id: "000102030405060708090a0b0c0d0e0f10111213", kind: "infohash" },
    ]);
    expect(read(`${B},magnet:?xt=urn:btih:${A}`)).toEqual([
      { line: 1, id: B, kind: null },
      { line: 1, id: A, kind: "infohash" },
    ]);
    expect(read(`Sports:magnet:?xt=urn:sha1:${A}`)).toEqual([{ line: 1, id: undefined, kind: undefined }]);
  });

  it("finds an identifier in a link that is escaped inside another link", () => {
    expect(read(`plugin://program.plexus/?url=acestream%3A%2F%2F${A}&mode=1`)).toEqual([
      { line: 1, id: A, kind: null },
    ]);
    expect(
      read(`http://proxy.example/play?url=http%3A%2F%2F127.0.0.1%3A6878%2Face%2Fgetstream%3Finfohash%3D${A}`),
    ).toEqual([{ line: 1, id: A, kind: "infohash" }]);
    expect(read(`http://proxy.example/play?url=magnet%3A%3Fxt%3Durn%3Abtih%3A${A}`)).toEqual([
      { line: 1, id: A, kind: null },
    ]);
  });

  it("says which line an identifier repeats", () => {
    expect(read(`${A}\nSports ${B}\nacestream://${A}\n${B} ${B.toUpperCase()}`)).toEqual([
      { line: 1, id: A, kind: null },
      { line: 2, id: B, kind: null },
      { line: 3, id: A, kind: null, repeats: 1 },
      { line: 4, id: B, kind: null, repeats: 2 },
      { line: 4, id: B, kind: null, repeats: 2 },
    ]);
    // Twice on one line: the second repeats the line it is on.
    expect(read(`${A} ${A}`)).toEqual([
      { line: 1, id: A, kind: null },
      { line: 1, id: A, kind: null, repeats: 1 },
    ]);
  });

  it("takes the kind a repeat says for the first one, which is the one that is added", () => {
    expect(read(`acestream://${A}\nhttp://127.0.0.1:6878/ace/getstream?infohash=${A}\nid=${A}`)).toEqual([
      { line: 1, id: A, kind: "infohash" },
      { line: 2, id: A, kind: "infohash", repeats: 1 },
      { line: 3, id: A, kind: "content-id", repeats: 1 },
    ]);
    // What the first one says itself stays.
    expect(read(`id=${A}\ninfohash=${A}`)).toEqual([
      { line: 1, id: A, kind: "content-id" },
      { line: 2, id: A, kind: "infohash", repeats: 1 },
    ]);
  });

  it("reads the streams of an M3U playlist and skips its # lines", () => {
    const playlist = [
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="s1" group-title="Sports, live",Sports 1 HD',
      "#EXTVLCOPT:network-caching=1000",
      `acestream://${A}`,
      "",
      // A directive is never a stream, whatever it holds: here a logo named after a hash.
      `#EXTINF:-1 tvg-logo="http://logos.example/${C}.png",News`,
      `http://127.0.0.1:6878/ace/getstream?id=${B}`,
      // Neither is a comment, or a stream that was commented out.
      "# old channels",
      "#EXTINF:-1,Old channel",
      `#acestream://${C}`,
      `  # ${C}`,
    ].join("\n");
    expect(read(playlist)).toEqual([
      { line: 4, id: A, kind: null },
      { line: 7, id: B, kind: "content-id" },
    ]);
    // A piece of a playlist is one too, wherever its first directive is, and however it is written.
    expect(read(`#${C}\n${A}\n\u{FEFF} #extinf:-1,News\n${B}`)).toEqual([
      { line: 2, id: A, kind: null },
      { line: 4, id: B, kind: null },
    ]);
  });

  it("reads a stream on a line that starts with # in a list that is no playlist, and skips its comments", () => {
    expect(read(`# my list\n#${A}\n#2 ${B}\n# Sports ${C}`)).toEqual([
      { line: 2, id: A, kind: null },
      { line: 3, id: B, kind: null },
      { line: 4, id: C, kind: null },
    ]);
  });

  it("reads a very long line in linear time", () => {
    // Runs that patterns like /\/+$/ or /[,;]+$/ would take quadratic time on.
    const long = `${"/".repeat(50_000)}x ${";".repeat(50_000)}x ${"a".repeat(50_000)} ${A}`;
    const started = performance.now();
    expect(read(long)).toEqual([{ line: 1, id: A, kind: null }]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("parseAceIdText", () => {
  it("reads the one stream a text names, whatever is around it", () => {
    expect(parseAceIdText(`acestream://${A}`)).toEqual({ id: A, kind: null });
    expect(parseAceIdText(` "Sports 1" - magnet:?xt=urn:btih:${A}, `)).toEqual({ id: A, kind: "infohash" });
  });

  it("gives nothing for no stream, or for more than one", () => {
    expect(parseAceIdText("")).toBeUndefined();
    expect(parseAceIdText("not a stream")).toBeUndefined();
    expect(parseAceIdText(`${A} ${B}`)).toBeUndefined();
    expect(parseAceIdText(`${A}\nnot a stream`)).toBeUndefined();
    // The same stream twice is still one entry too many.
    expect(parseAceIdText(`${A}\n${A}`)).toBeUndefined();
  });
});
