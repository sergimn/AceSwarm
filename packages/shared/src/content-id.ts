const CONTENT_ID_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Normalizes user input into a bare Acestream content ID. Accepts the raw 40 character hex ID, an
 * `acestream://` link, or a URL with an `id=` query parameter. Returns `undefined` when the input
 * does not contain a valid ID.
 */
export function normalizeContentId(input: string): string | undefined {
  let candidate = input.trim();
  if (candidate.toLowerCase().startsWith("acestream://")) {
    candidate = candidate.slice("acestream://".length);
  }
  const queryMatch = /[?&](?:id|content_id)=([0-9a-fA-F]{40})/.exec(candidate);
  if (queryMatch?.[1] !== undefined) {
    candidate = queryMatch[1];
  }
  candidate = candidate.replace(/\/+$/, "").toLowerCase();
  return CONTENT_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export function isContentId(value: string): boolean {
  return CONTENT_ID_PATTERN.test(value);
}
