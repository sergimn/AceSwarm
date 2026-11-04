import type { StreamView } from "@aceswarm/shared/api-types";

/** Where the controller serves a stream's HLS playlists and thumbnail (proxied to the transcoder). */
export function hlsUrls(streamId: string): StreamView["hls"] {
  return {
    preview: `/hls/${streamId}/preview/index.m3u8`,
    full: `/hls/${streamId}/full/index.m3u8`,
    thumbnail: `/hls/${streamId}/thumbnail.jpg`,
  };
}
