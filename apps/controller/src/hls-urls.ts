import type { StreamView } from "@aceswarm/shared/api-types";

/** Where the controller serves a stream's HLS playlists and thumbnail (proxied to the transcoder). */
export function hlsUrls(streamId: string): StreamView["hls"] {
  return {
    preview: `/hls/${streamId}/preview/index.m3u8`,
    full: `/hls/${streamId}/full/index.m3u8`,
    external: `/hls/${streamId}/external/index.m3u8`,
    thumbnail: `/hls/${streamId}/thumbnail.jpg`,
  };
}

/**
 * The stream whose playlist for players outside the page (`external` above) the transcoder serves
 * at this path, if it serves one there. The path is the one the proxy's request has, in which `.`
 * and `..` are already resolved; the transcoder's router then decodes each part of it once. Read
 * the same way here, `/hls/abcdef/%65xternal/index.m3u8` is that playlist too.
 */
export function externalPlaylistStream(pathname: string): string | undefined {
  let parts: string[];
  try {
    parts = pathname.split("/").map((part) => decodeURIComponent(part));
  } catch {
    // Not an address the transcoder can read either.
    return undefined;
  }
  const [root, hls, id = "", variant, file] = parts;
  const external =
    parts.length === 5 && root === "" && hls === "hls" && variant === "external" && file === "index.m3u8";
  return external && /^[a-z0-9]{6,32}$/.test(id) ? id : undefined;
}
