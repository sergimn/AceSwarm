import { expect, test } from "vitest";
import { externalPlaylistStream, hlsUrls } from "../src/hls-urls.ts";

test("a stream's playlist for players outside the page is told from every other address", () => {
  expect(externalPlaylistStream(hlsUrls("abcdef").external)).toBe("abcdef");
  expect(externalPlaylistStream(hlsUrls("abcdef").full)).toBeUndefined();
  expect(externalPlaylistStream(hlsUrls("abcdef").preview)).toBeUndefined();
  expect(externalPlaylistStream(hlsUrls("abcdef").thumbnail)).toBeUndefined();
  expect(externalPlaylistStream("/hls/abcdef/g1/full/seg_000001.ts")).toBeUndefined();
  expect(externalPlaylistStream("/hls/abcdef/slate/seg_000.ts")).toBeUndefined();
  // What can't be a stream's id has none, as on the transcoder.
  for (const id of ["abc", "ABCDEF", "abc_def", "a".repeat(33), ""]) {
    expect(externalPlaylistStream(`/hls/${id}/external/index.m3u8`), id).toBeUndefined();
  }
});

test("the address is read as the transcoder's router reads it: each part decoded once", () => {
  for (const path of [
    "/hls/abcdef/%65xternal/index.m3u8",
    "/hls/abcdef/external/index%2Em3u8",
    "/hls/abcdef/external/%69ndex.m3u8",
    "/hls/%61bcdef/external/index.m3u8",
    "/%68ls/abcdef/external/index.m3u8",
  ]) {
    expect(externalPlaylistStream(path), path).toBe("abcdef");
  }
  // Decoded twice it would be the playlist; the router doesn't, so it isn't.
  expect(externalPlaylistStream("/hls/abcdef/%2565xternal/index.m3u8")).toBeUndefined();
  // An encoded slash is part of a name, not between two; so is one more slash, and what follows a `;`.
  for (const path of [
    "/hls/abcdef%2Fexternal/index.m3u8",
    "/hls/abcdef/external%2Findex.m3u8",
    "/hls/abcdef//external/index.m3u8",
    "/hls/abcdef/external/index.m3u8/",
    "/hls/abcdef/external/index.m3u8;x",
    "/hls/abcdef/External/index.m3u8",
    "/hls/abcdef/external/index.m3u8/more",
    "/api/hls/abcdef/external/index.m3u8",
    // Not an address at all.
    "/hls/abcdef/external/index.m3u8%zz",
    "/hls/abcdef/%E0%A4%A/index.m3u8",
  ]) {
    expect(externalPlaylistStream(path), path).toBeUndefined();
  }
});
