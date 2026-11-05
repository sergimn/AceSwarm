import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeError } from "@aceswarm/shared/http";
import { NETWORK_POLICY_FILE, parseNetworkPolicy, type PolicyParseResult } from "@aceswarm/shared/network-policy";

/**
 * Reads the network policy the controller keeps next to the WireGuard profiles. No file means the
 * default policy; a file that can't be read or understood turns the direct path off.
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
