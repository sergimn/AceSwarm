import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../src/exec.ts";
import { Router, type PathFirewall } from "../src/router.ts";
import type { Tunnel } from "../src/tunnels.ts";

/**
 * Records commands; `ip rule del` fails like it does when no rule is left. Each command yields to
 * the event loop like a real process would, so a loop that never ends fails on the test timeout.
 */
class FakeRunner implements CommandRunner {
  readonly calls: string[] = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push(`${command} ${args.join(" ")}`);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return { stdout: "", stderr: "", code: args.includes("del") ? 2 : 0 };
  }
}

/** Keeps the set of allowed `engine>iface` pairs, like the gateway's forward chain. */
class FakeFirewall implements PathFirewall {
  readonly allowed = new Set<string>();

  allow(ip: string, iface: string): Promise<void> {
    this.allowed.add(`${ip}>${iface}`);
    return Promise.resolve();
  }

  revoke(ip: string): Promise<void> {
    for (const rule of this.allowed) {
      if (rule.startsWith(`${ip}>`)) {
        this.allowed.delete(rule);
      }
    }
    return Promise.resolve();
  }
}

function tunnel(iface: string, table: number): Tunnel {
  return {
    profile: iface,
    pathId: `wg:${iface}`,
    iface,
    table,
    address: "10.13.13.2",
    config: undefined,
    text: "",
    error: null,
  };
}

function setup(): {
  runner: FakeRunner;
  firewall: FakeFirewall;
  router: Router;
  tunnels: Map<string, Tunnel>;
  clock: { now: number };
} {
  const runner = new FakeRunner();
  const firewall = new FakeFirewall();
  const tunnels = new Map<string, Tunnel>([["wg:a", tunnel("aswg0", 101)]]);
  const clock = { now: 0 };
  const router = new Router({
    runner,
    subnet: "172.31.250.0/24",
    directIface: "eth1",
    tunnel: (path) => tunnels.get(path),
    firewall,
    logger: createLogger("test", "silent"),
    now: () => clock.now,
  });
  return { runner, firewall, router, tunnels, clock };
}

describe("Router.assign", () => {
  it("only lets an engine out through its own path", async () => {
    const { router, firewall } = setup();
    await router.assign("172.31.250.10", "direct");
    await router.assign("172.31.250.11", "wg:a");
    expect([...firewall.allowed]).toEqual(["172.31.250.10>eth1", "172.31.250.11>aswg0"]);

    await router.assign("172.31.250.11", "direct");
    expect([...firewall.allowed]).toEqual(["172.31.250.10>eth1", "172.31.250.11>eth1"]);

    await router.unassign("172.31.250.10");
    expect(router.pathOf("172.31.250.10")).toBeUndefined();
    expect([...firewall.allowed]).toEqual(["172.31.250.11>eth1"]);
  });

  it("does not touch the kernel when the same path is confirmed again", async () => {
    const { router, runner } = setup();
    await router.assign("172.31.250.11", "wg:a");
    runner.calls.length = 0;
    await router.assign("172.31.250.11", "wg:a");
    expect(runner.calls).toEqual([]);
  });

  it("refuses unknown and broken tunnels", async () => {
    const { router, tunnels } = setup();
    await expect(router.assign("172.31.250.10", "wg:missing")).rejects.toThrow("unknown path");
    tunnels.set("wg:b", { ...tunnel("aswg1", 102), error: "handshake failed" });
    await expect(router.assign("172.31.250.10", "wg:b")).rejects.toThrow("unknown path");
    await expect(router.assign("10.0.0.5", "direct")).rejects.toThrow("not on the engines network");
  });
});

describe("overlapping changes", () => {
  it("leave exactly the rules of the last requested path", async () => {
    const { router, firewall, runner } = setup();
    await router.assign("172.31.250.11", "direct");

    // A reload (every minute, and on every profile change) overlapping a path change.
    await Promise.all([
      router.reapply(),
      router.assign("172.31.250.11", "wg:a"),
      router.reapply(),
      router.assign("172.31.250.11", "direct"),
      router.assign("172.31.250.11", "wg:a"),
    ]);

    expect(router.pathOf("172.31.250.11")).toBe("wg:a");
    expect([...firewall.allowed]).toEqual(["172.31.250.11>aswg0"]);
    // Every `ip rule add` for the engine was preceded by deleting the previous one.
    const rules = runner.calls.filter((call) => call.startsWith("ip -4 rule"));
    expect(rules.at(-1)).toBe("ip -4 rule add from 172.31.250.11/32 lookup 101 priority 1000");
    expect(rules.at(-2)).toContain("ip -4 rule del from 172.31.250.11/32");
  });

  it("revokes the engine's rules for every interface, not only the one it expects", async () => {
    const { router, firewall } = setup();
    await router.assign("172.31.250.11", "wg:a");
    firewall.allowed.add("172.31.250.11>eth1"); // left behind by an earlier crash, say

    await router.unassign("172.31.250.11");

    expect([...firewall.allowed]).toEqual([]);
  });
});

describe("Router.reapply", () => {
  it("finishes and keeps every assignment", async () => {
    const { router } = setup();
    await router.assign("172.31.250.10", "direct");
    await router.assign("172.31.250.11", "wg:a");
    await router.assign("172.31.250.12", "direct");

    await router.reapply();

    expect(router.list()).toEqual([
      { ip: "172.31.250.10", path: "direct" },
      { ip: "172.31.250.11", path: "wg:a" },
      { ip: "172.31.250.12", path: "direct" },
    ]);
  });

  it("cuts engines off when their tunnel is removed instead of sending them direct", async () => {
    const { runner, router, tunnels, firewall } = setup();
    await router.assign("172.31.250.10", "direct");
    await router.assign("172.31.250.11", "wg:a");
    tunnels.delete("wg:a");
    runner.calls.length = 0;

    await router.reapply();

    expect(router.pathOf("172.31.250.11")).toBeUndefined();
    expect([...firewall.allowed]).toEqual(["172.31.250.10>eth1"]);
    expect(runner.calls.filter((call) => call.startsWith("conntrack -D"))).toEqual(["conntrack -D -s 172.31.250.11"]);
  });
});

describe("Router.sync", () => {
  it("restores assignments after a gateway restart and reports the ones it cannot apply", async () => {
    const { router, firewall } = setup();
    const rejected = await router.sync(
      [
        { ip: "172.31.250.10", path: "wg:a" },
        { ip: "172.31.250.11", path: "direct" },
        { ip: "172.31.250.12", path: "wg:gone" },
      ],
      30_000,
    );
    expect(router.list()).toEqual([
      { ip: "172.31.250.10", path: "wg:a" },
      { ip: "172.31.250.11", path: "direct" },
    ]);
    expect(rejected).toEqual([{ ip: "172.31.250.12", path: "wg:gone", error: "unknown path wg:gone" }]);
    expect(firewall.allowed.has("172.31.250.12>eth1")).toBe(false);
  });

  it("keeps a newer path when the controller's list was built before it", async () => {
    const { router } = setup();
    await router.assign("172.31.250.10", "wg:a");

    await router.sync([{ ip: "172.31.250.10", path: "direct" }], 30_000);

    expect(router.pathOf("172.31.250.10")).toBe("wg:a");
  });

  it("removes engines the controller stopped mentioning, after a grace period", async () => {
    const { router, clock } = setup();
    await router.assign("172.31.250.10", "direct");
    await router.assign("172.31.250.20", "wg:a");

    // A sync computed before .20 was assigned must not undo it right away.
    clock.now = 10_000;
    await router.sync([{ ip: "172.31.250.10", path: "direct" }], 30_000);
    expect(router.pathOf("172.31.250.20")).toBe("wg:a");

    clock.now = 40_000;
    await router.sync([{ ip: "172.31.250.10", path: "direct" }], 30_000);
    expect(router.pathOf("172.31.250.20")).toBeUndefined();
    expect(router.pathOf("172.31.250.10")).toBe("direct");
  });
});
