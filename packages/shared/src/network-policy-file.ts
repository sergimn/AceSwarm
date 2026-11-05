import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeError } from "./http.ts";
import { NETWORK_POLICY_FILE, parseNetworkPolicy, type PolicyParseResult } from "./network-policy.ts";

/**
 * Reads the network policy from the WireGuard profile directory, for the controller and the
 * gateway alike. No file means the default policy; a file that can't be read or understood keeps
 * the direct path off. (Separate from `network-policy.ts`, which the browser UI also imports.)
 */
export async function readNetworkPolicy(directory: string): Promise<PolicyParseResult> {
  let text: string | undefined;
  try {
    text = await readFile(join(directory, NETWORK_POLICY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { policy: { wireguardOnly: true }, error: `cannot read the network policy: ${describeError(error)}` };
    }
  }
  return parseNetworkPolicy(text);
}
