import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readNetworkPolicy } from "../src/policy.ts";

describe("readNetworkPolicy", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aceswarm-policy-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("allows the direct path when there is no policy file", async () => {
    expect(await readNetworkPolicy(directory)).toEqual({ policy: { wireguardOnly: false }, error: null });
  });

  it("reads the policy the controller wrote", async () => {
    await writeFile(join(directory, "policy.json"), JSON.stringify({ version: 1, wireguardOnly: true }));
    expect(await readNetworkPolicy(directory)).toEqual({ policy: { wireguardOnly: true }, error: null });
  });

  it("keeps the direct path off when the file is broken", async () => {
    await writeFile(join(directory, "policy.json"), '{"version": 1, "wireguardOnly": tr');
    const result = await readNetworkPolicy(directory);
    expect(result.policy.wireguardOnly).toBe(true);
    expect(result.error).toContain("not valid JSON");
  });

  it.skipIf(process.getuid?.() === 0)("keeps the direct path off when the file can't be read", async () => {
    const file = join(directory, "policy.json");
    await writeFile(file, JSON.stringify({ version: 1, wireguardOnly: false }));
    await chmod(file, 0o000);
    const result = await readNetworkPolicy(directory);
    expect(result.policy.wireguardOnly).toBe(true);
    expect(result.error).toContain("cannot read");
  });
});
