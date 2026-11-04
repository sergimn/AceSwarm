import { describe, expect, it } from "vitest";
import { getstreamParameter, isAceId, kindsToTry, parseAceId } from "../src/ace-id.ts";

const HEX = "6d325cda6ed591647ef5e91edd043147bce8be30";

describe("parseAceId", () => {
  it("leaves the kind open for a bare 40 hex value", () => {
    expect(parseAceId(HEX)).toEqual({ id: HEX, kind: null });
  });

  it("normalizes case, whitespace and acestream:// links", () => {
    expect(parseAceId(`  ${HEX.toUpperCase()}  `)).toEqual({ id: HEX, kind: null });
    expect(parseAceId(`acestream://${HEX}`)).toEqual({ id: HEX, kind: null });
    expect(parseAceId(`ACESTREAM://${HEX}/`)).toEqual({ id: HEX, kind: null });
  });

  it("reads the kind from engine URLs", () => {
    expect(parseAceId(`http://127.0.0.1:6878/ace/getstream?infohash=${HEX}`)).toEqual({ id: HEX, kind: "infohash" });
    expect(parseAceId(`http://127.0.0.1:6878/ace/getstream?id=${HEX}&pid=1`)).toEqual({ id: HEX, kind: "content-id" });
    expect(parseAceId(`http://host/ace/manifest.m3u8?content_id=${HEX}`)).toEqual({ id: HEX, kind: "content-id" });
  });

  it("treats magnet links as infohashes, hex or base32", () => {
    expect(parseAceId(`magnet:?xt=urn:btih:${HEX}&dn=x`)).toEqual({ id: HEX, kind: "infohash" });
    // Base32 of 0x00..0x13 (20 bytes).
    const base32 = "aaaqeayeaudaocajbifqydiob4ibceqt";
    expect(parseAceId(`magnet:?xt=urn:btih:${base32}`)).toEqual({
      id: "000102030405060708090a0b0c0d0e0f10111213",
      kind: "infohash",
    });
  });

  it("rejects anything else", () => {
    expect(parseAceId("")).toBeUndefined();
    expect(parseAceId(HEX.slice(1))).toBeUndefined();
    expect(parseAceId(`${HEX}0`)).toBeUndefined();
    expect(parseAceId("magnet:?xt=urn:btih:nothex")).toBeUndefined();
    expect(parseAceId(`https://example.com/?q=${HEX}`)).toBeUndefined();
  });
});

describe("helpers", () => {
  it("checks the stored format", () => {
    expect(isAceId(HEX)).toBe(true);
    expect(isAceId(HEX.toUpperCase())).toBe(false);
  });

  it("tries the known kind first, content IDs first when unknown", () => {
    expect(kindsToTry(null)).toEqual(["content-id", "infohash"]);
    expect(kindsToTry("content-id")).toEqual(["content-id", "infohash"]);
    expect(kindsToTry("infohash")).toEqual(["infohash", "content-id"]);
  });

  it("maps kinds to getstream parameters", () => {
    expect(getstreamParameter("content-id")).toBe("id");
    expect(getstreamParameter("infohash")).toBe("infohash");
  });
});
