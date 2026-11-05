import { join } from "node:path";
import {
  DEFAULT_NETWORK_POLICY,
  NETWORK_POLICY_FILE,
  serializeNetworkPolicy,
  type NetworkPolicy,
} from "@aceswarm/shared/network-policy";
import { readNetworkPolicy } from "@aceswarm/shared/network-policy-file";
import { writeJsonFile } from "./json-file.ts";

/**
 * Keeps the network policy in `<data>/wireguard/policy.json`, next to the profiles, where the
 * network gateway reads it too (read-only).
 */
export class NetworkPolicyStore {
  private readonly directory: string;
  private readonly path: string;
  private current: NetworkPolicy = { ...DEFAULT_NETWORK_POLICY };

  /** `directory` is the WireGuard profile directory. */
  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, NETWORK_POLICY_FILE);
  }

  /** Reads the file. Returns why it could not be read or understood, in which case the direct path is off. */
  async load(): Promise<string | null> {
    const { policy, error } = await readNetworkPolicy(this.directory);
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
