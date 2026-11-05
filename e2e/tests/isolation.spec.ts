import { expect, test } from "@playwright/test";
import {
  addStream,
  compose,
  engineContainers,
  engineNetworkIp,
  fetchFromEngine,
  mockId,
  resetStack,
  waitForPlaying,
} from "./helpers.ts";

// Engines run third-party P2P software, so they must not be able to steer the stack, for example
// by asking the gateway to move them off their VPN.
test("engines can't reach the gateway, controller or transcoder APIs", async ({ request }) => {
  await resetStack(request);
  const stream = await addStream(request, mockId("e1", "content-id", 31), "Isolation");
  await waitForPlaying(request, stream.id);
  const [engine] = engineContainers(stream.id);
  expect(engine).toBeDefined();

  // The gateway's firewall drops new connections from engines (and its API would refuse them).
  const gateway = fetchFromEngine(engine!, `http://${engineNetworkIp("netgw")}:8082/assignments`);
  expect(gateway.ok).toBe(false);
  expect(gateway.output).toContain("timed out");

  // The controller and transcoder are on the engines network to reach the engines, and refuse
  // requests coming from it.
  for (const url of [
    `http://${engineNetworkIp("controller")}:8080/api/streams`,
    `http://${engineNetworkIp("transcoder")}:8081/healthz`,
  ]) {
    const result = fetchFromEngine(engine!, url);
    expect(result.ok, url).toBe(false);
    expect(result.output, url).toContain("403");
  }
});

// Peers live on the public internet. Engines must not reach the host's published ports (rootless
// Podman exposes them on 169.254.1.2), the LAN or other private addresses, on any path.
test("the gateway drops engine connections to private addresses before any engine is allowed out", () => {
  const forward = compose("exec", "-T", "netgw", "iptables", "-S", "ACESWARM-FWD").split("\n");
  const jump = forward.findIndex((rule) => rule.includes("-j ACESWARM-DST"));
  const firstAccept = forward.findIndex((rule) => /-s \S+\/32 .*-j ACCEPT/.test(rule));
  expect(jump).toBeGreaterThan(-1);
  if (firstAccept !== -1) {
    expect(jump).toBeLessThan(firstAccept);
  }
  const destinations = compose("exec", "-T", "netgw", "iptables", "-S", "ACESWARM-DST");
  for (const network of ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"]) {
    expect(destinations).toContain(`-d ${network} -j DROP`);
  }
});
