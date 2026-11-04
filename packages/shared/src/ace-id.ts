/**
 * Acestream streams are identified either by a content ID or by the infohash of their torrent.
 * Both are 40 hexadecimal characters, so a bare value cannot be told apart: the controller tries
 * one kind with the engine, falls back to the other, and remembers what worked.
 */

export type AceIdKind = "content-id" | "infohash";

export const ACE_ID_KINDS: readonly AceIdKind[] = ["content-id", "infohash"];

export interface ParsedAceId {
  /** 40 lowercase hexadecimal characters. */
  id: string;
  /** Kind implied by the input (for example a magnet link), or null when it is ambiguous. */
  kind: AceIdKind | null;
}

const HEX_ID = /^[0-9a-f]{40}$/;
const BASE32_ID = /^[a-z2-7]{32}$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Decodes a 32 character base32 infohash (as some magnet links carry) to hex. */
function base32ToHex(value: string): string {
  let bits = "";
  for (const char of value) {
    bits += BASE32_ALPHABET.indexOf(char).toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let index = 0; index + 4 <= bits.length; index += 4) {
    hex += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
  }
  return hex;
}

function fromMagnet(input: string): string | undefined {
  const match = /[?&]xt=urn:btih:([0-9a-z]+)/i.exec(input);
  const value = match?.[1]?.toLowerCase();
  if (value === undefined) {
    return undefined;
  }
  if (HEX_ID.test(value)) {
    return value;
  }
  return BASE32_ID.test(value) ? base32ToHex(value) : undefined;
}

/**
 * Extracts a stream identifier from what a user pasted: a bare 40 character hex value, an
 * `acestream://` link, a magnet link, or a URL with an `id`, `content_id` or `infohash` parameter.
 */
export function parseAceId(input: string): ParsedAceId | undefined {
  const text = input.trim();
  if (/^magnet:/i.test(text)) {
    const id = fromMagnet(text);
    return id === undefined ? undefined : { id, kind: "infohash" };
  }
  const infohash = /[?&]infohash=([0-9a-f]{40})(?:&|$)/i.exec(text)?.[1];
  if (infohash !== undefined) {
    return { id: infohash.toLowerCase(), kind: "infohash" };
  }
  const contentId = /[?&](?:id|content_id)=([0-9a-f]{40})(?:&|$)/i.exec(text)?.[1];
  if (contentId !== undefined) {
    return { id: contentId.toLowerCase(), kind: "content-id" };
  }
  const bare = text
    .replace(/^acestream:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return HEX_ID.test(bare) ? { id: bare, kind: null } : undefined;
}

export function isAceId(value: string): boolean {
  return HEX_ID.test(value);
}

/** Kinds to try when starting a session: the known one first, then the other one. */
export function kindsToTry(known: AceIdKind | null): AceIdKind[] {
  return known === "infohash" ? ["infohash", "content-id"] : ["content-id", "infohash"];
}

/** Query parameter the engine's `getstream` expects for a kind. */
export function getstreamParameter(kind: AceIdKind): "id" | "infohash" {
  return kind === "infohash" ? "infohash" : "id";
}
