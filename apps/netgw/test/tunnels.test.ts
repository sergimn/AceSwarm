import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it, onTestFinished } from "vitest";
import type { CommandResult, CommandRunner } from "../src/exec.ts";
import { TunnelManager } from "../src/tunnels.ts";

/** Records every command and succeeds. */
class FakeRunner implements CommandRunner {
  calls: string[] = [];

  run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push(`${command} ${args.join(" ")}`);
    return Promise.resolve({ stdout: "", stderr: "", code: 0 });
  }
}

// Throwaway, syntactically valid keys (not real credentials).
const PRIVATE = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const PUBLIC = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";

// Every ProtonVPN profile has this Address, and the profiles of one Mullvad device share one too.
const SHARED = "10.2.0.2/32";

function profile(): string {
  return `[Interface]
PrivateKey = ${PRIVATE}
Address = ${SHARED}

[Peer]
PublicKey = ${PUBLIC}
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
`;
}

async function setup(profiles: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "aceswarm-tunnels-"));
  const runtimeDir = await mkdtemp(join(tmpdir(), "aceswarm-tunnels-run-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true });
  });
  for (const [name, text] of Object.entries(profiles)) {
    await writeFile(join(directory, `${name}.conf`), text);
  }
  const runner = new FakeRunner();
  const manager = new TunnelManager(runner, directory, runtimeDir, createLogger("test", "silent"));
  return { runner, manager, directory };
}

describe("TunnelManager with profiles that share an Address", () => {
  it("gives each its own interface and routing table", async () => {
    const { runner, manager } = await setup({ "proton-ch": profile(), "proton-nl": profile() });
    await manager.reconcile();
    expect(manager.list().map(({ profile, iface, table, error }) => ({ profile, iface, table, error }))).toEqual([
      { profile: "proton-ch", iface: "aswg0", table: 100, error: null },
      { profile: "proton-nl", iface: "aswg1", table: 101, error: null },
    ]);
    expect(runner.calls).toContain("ip -4 address add 10.2.0.2/32 dev aswg0");
    expect(runner.calls).toContain("ip -4 address add 10.2.0.2/32 dev aswg1");
    expect(runner.calls).toContain("ip -4 route replace default dev aswg0 table 100");
    expect(runner.calls).toContain("ip -4 route replace default dev aswg1 table 101");
  });

  it("keeps everything but the address assignment from being keyed by the Address", async () => {
    // A rule or route that mentions the Address cannot tell two such tunnels apart: the second
    // one replaces or deletes the first one's.
    const { runner, manager } = await setup({ "proton-ch": profile(), "proton-nl": profile() });
    await manager.reconcile();
    expect(runner.calls.filter((call) => call.includes("10.2.0.2"))).toEqual([
      "ip -4 address add 10.2.0.2/32 dev aswg0",
      "ip -4 address add 10.2.0.2/32 dev aswg1",
    ]);
  });

  it("leaves the other tunnel alone when one is removed", async () => {
    const { runner, manager, directory } = await setup({ "proton-ch": profile(), "proton-nl": profile() });
    await manager.reconcile();
    runner.calls = [];
    await unlink(join(directory, "proton-ch.conf"));
    expect(await manager.reconcile()).toEqual({ added: [], removed: ["proton-ch"] });
    expect(runner.calls).toEqual(["ip -4 route flush table 100", "ip link del aswg0"]);
    expect(manager.list().map((tunnel) => tunnel.iface)).toEqual(["aswg1"]);
  });
});
