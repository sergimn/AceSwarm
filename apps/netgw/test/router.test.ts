import { createLogger } from "@aceswarm/shared/logger";
import { describe, expect, it } from "vitest";
import type { CommandResult, CommandRunner } from "../src/exec.ts";
import { Router } from "../src/router.ts";
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

function setup(): { runner: FakeRunner; router: Router; tunnels: Map<string, Tunnel> } {
  const runner = new FakeRunner();
  const tunnels = new Map<string, Tunnel>([["wg:a", { table: 101 } as Tunnel]]);
  const router = new Router(runner, "172.31.250.0/24", (path) => tunnels.get(path), createLogger("test", "silent"));
  return { runner, router, tunnels };
}

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

  it("moves engines off removed tunnels and flushes their connections", async () => {
    const { runner, router, tunnels } = setup();
    await router.assign("172.31.250.10", "direct");
    await router.assign("172.31.250.11", "wg:a");
    tunnels.delete("wg:a");
    runner.calls.length = 0;

    await router.reapply();

    expect(router.pathOf("172.31.250.11")).toBe("direct");
    expect(runner.calls.filter((call) => call.startsWith("conntrack -D"))).toEqual(["conntrack -D -s 172.31.250.11"]);
  });
});
