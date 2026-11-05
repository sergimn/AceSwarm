import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describeError } from "@aceswarm/shared/http";
import {
  DEFAULT_NETWORK_POLICY,
  NETWORK_POLICY_FILE,
  parseNetworkPolicy,
  serializeNetworkPolicy,
  type NetworkPolicy,
} from "@aceswarm/shared/network-policy";
import { writeJsonFile } from "./json-file.ts";

/**
 * Keeps the network policy in `<data>/wireguard/policy.json`, next to the profiles, where the
 * network gateway reads it too (read-only).
 */
export class NetworkPolicyStore {
  private readonly path: string;
  private current: NetworkPolicy = { ...DEFAULT_NETWORK_POLICY };

  /** `directory` is the WireGuard profile directory. */
  constructor(directory: string) {
    this.path = join(directory, NETWORK_POLICY_FILE);
  }

  /** Reads the file. Returns why it could not be read or understood, in which case the direct path is off. */
  async load(): Promise<string | null> {
    let text: string | undefined;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.current = { wireguardOnly: true };
        return `cannot read the network policy: ${describeError(error)}`;
      }
    }
    const { policy, error } = parseNetworkPolicy(text);
    this.current = policy;
    return error;
  }

  get(): NetworkPolicy {
    return { ...this.current };
  }

  async save(policy: NetworkPolicy): Promise<void> {
    await writeJsonFile(this.path, serializeNetworkPolicy(policy));
    this.current = { ...policy };
  }
}
