import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/exec.ts";
import type { GeoLookup } from "../src/geoip.ts";
import { parseConntrack, PeerTracker } from "../src/peers.ts";

const ENGINE = "172.31.250.130";

function udp(remote: string, bytes: number, port = 8621): string {
  return `udp      17 29 src=${ENGINE} dst=${remote} sport=8621 dport=${String(port)} packets=10 bytes=900 src=${remote} dst=198.51.100.2 sport=${String(port)} dport=8621 packets=12 bytes=${String(bytes)} mark=0 use=1`;
}

const TCP_ESTABLISHED = `ipv4     2 tcp      6 431999 ESTABLISHED src=${ENGINE} dst=93.184.216.34 sport=40000 dport=7764 packets=5 bytes=400 src=93.184.216.34 dst=198.51.100.2 sport=7764 dport=40000 packets=6 bytes=5000 [ASSURED] mark=0 use=1`;
const TCP_SYN = `tcp      6 119 SYN_SENT src=${ENGINE} dst=93.184.216.35 sport=40001 dport=7764 [UNREPLIED] src=93.184.216.35 dst=198.51.100.2 sport=7764 dport=40001 mark=0 use=1`;

const geo: GeoLookup = {
  country: (ip) => ({ "1.1.1.1": "AU", "8.8.8.8": "US", "9.9.9.9": "CH", "93.184.216.34": "US" })[ip],
};

const runner: CommandRunner = {
  run: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
};

describe("parseConntrack", () => {
  it("reads engine, remote, reply state and received bytes", () => {
    const [udpFlow, established, syn] = parseConntrack(
      [udp("1.1.1.1", 5000), TCP_ESTABLISHED, TCP_SYN, "junk"].join("\n"),
    );
    expect(udpFlow).toMatchObject({
      protocol: "udp",
      source: ENGINE,
      remote: "1.1.1.1",
      remotePort: 8621,
      replied: true,
      receivedBytes: 5000,
    });
    expect(established).toMatchObject({ protocol: "tcp", remote: "93.184.216.34", replied: true, receivedBytes: 5000 });
    expect(syn).toMatchObject({ protocol: "tcp", replied: false, receivedBytes: undefined });
  });
});

describe("PeerTracker", () => {
  it("counts connected peers and only the ones still sending as active", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [53], () => 0);
    tracker.update(parseConntrack([udp("1.1.1.1", 1000), udp("8.8.8.8", 1000), udp("9.9.9.9", 1000)].join("\n")));
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, active: 3 });

    // Only 8.8.8.8 sent more data since the previous sample.
    tracker.update(parseConntrack([udp("1.1.1.1", 1000), udp("8.8.8.8", 4000), udp("9.9.9.9", 1000)].join("\n")));
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, active: 1, countries: [{ code: "US", count: 1 }] });
  });

  it("ignores private remotes, other subnets and ignored ports", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [53], () => 0);
    tracker.update(
      parseConntrack(
        [
          udp("192.168.1.10", 100),
          udp("1.1.1.1", 100, 53),
          udp("8.8.8.8", 100).replace(`src=${ENGINE}`, "src=172.31.1.5"),
        ].join("\n"),
      ),
    );
    expect(tracker.all()).toEqual([]);
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 0, active: null, countries: [] });
  });

  it("reports active as unknown without conntrack accounting", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [], () => 0);
    tracker.update(parseConntrack(udp("1.1.1.1", 0).replaceAll(/ packets=\d+ bytes=\d+/g, "")));
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 1, active: null, countries: [{ code: "AU", count: 1 }] });
  });
});
