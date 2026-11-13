import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/exec.ts";
import { StaticGeoLookup, type GeoLookup } from "../src/geoip.ts";
import { parseConntrack, PeerTracker, REPLY_SHARE, UPLOAD_MIN_BYTES } from "../src/peers.ts";

const ENGINE = "172.31.250.130";

function udp(remote: string, bytes: number, port = 8621, sent = 900): string {
  return `udp      17 29 src=${ENGINE} dst=${remote} sport=8621 dport=${String(port)} packets=10 bytes=${String(sent)} src=${remote} dst=198.51.100.2 sport=${String(port)} dport=8621 packets=12 bytes=${String(bytes)} mark=0 use=1`;
}

/** Flows to three peers, with the bytes the engine sent each and received from each. */
function flows(traffic: [number, number][]): string {
  return ["1.1.1.1", "8.8.8.8", "9.9.9.9"]
    .map((remote, index) => udp(remote, traffic[index]![1], 8621, traffic[index]![0]))
    .join("\n");
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
      sentBytes: 900,
    });
    expect(established).toMatchObject({
      protocol: "tcp",
      remote: "93.184.216.34",
      replied: true,
      receivedBytes: 5000,
      sentBytes: 400,
    });
    expect(syn).toMatchObject({ protocol: "tcp", replied: false, receivedBytes: undefined, sentBytes: undefined });
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

  it("counts the peers the engine sent at least one block more than its replies to them since the previous sample", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [], () => 0);
    tracker.update(
      parseConntrack(
        flows([
          [100, 1000],
          [100, 1000],
          [50_000, 1000],
        ]),
      ),
    );
    // A flow seen for the first time counts everything it sent so far.
    expect(tracker.get(ENGINE)).toMatchObject({ uploading: 1 });

    // 1.1.1.1 sent 4 MB and got back acknowledgements and requests (more than a block, but no stream
    // data), 8.8.8.8 got a block, and 9.9.9.9 a block on top of the replies to the 2 MB it sent.
    const download = 4_000_000;
    const replies = download / 10;
    const both = 2_000_000;
    tracker.update(
      parseConntrack(
        flows([
          [100 + replies, 1000 + download],
          [100 + UPLOAD_MIN_BYTES, 1000],
          [50_000 + both * REPLY_SHARE + UPLOAD_MIN_BYTES, 1000 + both],
        ]),
      ),
    );
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, uploading: 2 });

    // One byte short of a block, or of a block beyond the replies, doesn't count.
    tracker.update(
      parseConntrack(
        flows([
          [100 + replies, 1000 + download],
          [100 + 2 * UPLOAD_MIN_BYTES - 1, 1000],
          [50_000 + both * REPLY_SHARE * 2 + UPLOAD_MIN_BYTES * 2 - 1, 1000 + both * 2],
        ]),
      ),
    );
    expect(tracker.get(ENGINE)).toMatchObject({ uploading: 0 });
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
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 0, active: null, uploading: null, countries: [] });
  });

  it("reports active as unknown without conntrack accounting", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [], () => 0);
    tracker.update(parseConntrack(udp("1.1.1.1", 0).replaceAll(/ packets=\d+ bytes=\d+/g, "")));
    expect(tracker.get(ENGINE)).toMatchObject({
      connected: 1,
      active: null,
      uploading: null,
      countries: [{ code: "AU", count: 1 }],
    });
  });
});

describe("StaticGeoLookup", () => {
  it("answers fixed entries first and falls back to the database", () => {
    const entries = StaticGeoLookup.parse(["198.51.100.10=es", "bad", "203.0.113.10 = SE", "1.2.3.4=USA"]);
    expect([...entries]).toEqual([["198.51.100.10", "ES"]]);
    const lookup = new StaticGeoLookup(entries, geo);
    expect(lookup.country("198.51.100.10")).toBe("ES");
    expect(lookup.country("1.1.1.1")).toBe("AU");
    expect(lookup.country("5.5.5.5")).toBeUndefined();
  });
});
