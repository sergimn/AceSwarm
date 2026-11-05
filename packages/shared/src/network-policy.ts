/**
 * Which network paths engines may use. The controller writes the policy into the WireGuard profile
 * directory and the network gateway reads it from there, so both enforce the same rules, and the
 * gateway knows them as soon as it starts, before the controller sends any engine paths.
 */

import { z } from "zod";

/** Id of the path that leaves through the host's own connection, without a VPN. */
export const DIRECT_PATH_ID = "direct";

/** Name of the policy file in the WireGuard profile directory. */
export const NETWORK_POLICY_FILE = "policy.json";

export interface NetworkPolicy {
  /** Engines may only use WireGuard paths: the direct path is off. */
  wireguardOnly: boolean;
}

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = { wireguardOnly: false };

const fileSchema = z.object({
  version: z.literal(1),
  wireguardOnly: z.boolean(),
});

/** What the policy file holds. */
export function serializeNetworkPolicy(policy: NetworkPolicy): { version: 1; wireguardOnly: boolean } {
  return { version: 1, wireguardOnly: policy.wireguardOnly };
}

export interface PolicyParseResult {
  policy: NetworkPolicy;
  /** Why the file could not be understood; the policy then keeps the direct path off. */
  error: string | null;
}

/**
 * Reads the policy file's contents (`undefined` when there is no file, which means the default).
 * A file that exists but can't be understood turns the direct path off: failing closed may stop
 * streams, but it never lets them leak out of their VPN.
 */
export function parseNetworkPolicy(text: string | undefined): PolicyParseResult {
  if (text === undefined) {
    return { policy: { ...DEFAULT_NETWORK_POLICY }, error: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { policy: { wireguardOnly: true }, error: "the network policy file is not valid JSON" };
  }
  const parsed = fileSchema.safeParse(raw);
  return parsed.success
    ? { policy: { wireguardOnly: parsed.data.wireguardOnly }, error: null }
    : { policy: { wireguardOnly: true }, error: "the network policy file has an unknown format" };
}

/** Whether engines may use a path under the policy. */
export function isPathAllowed(policy: NetworkPolicy, pathId: string): boolean {
  return !policy.wireguardOnly || pathId !== DIRECT_PATH_ID;
}
