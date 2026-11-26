import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/exec.ts";
import { StaticGeoLookup, type GeoLookup } from "../src/geoip.ts";
import { DATA_MIN_BYTES, parseConntrack, PEER_MIN_BYTES, PeerTracker, REPLY_SHARE } from "../src/peers.ts";

const ENGINE = "172.31.250.130";

function udp(remote: string, bytes: number, port = 8621, sent = 900): string {
  return `udp      17 29 src=${ENGINE} dst=${remote} sport=8621 dport=${String(port)} packets=10 bytes=${String(sent)} src=${remote} dst=198.51.100.2 sport=${String(port)} dport=8621 packets=12 bytes=${String(bytes)} mark=0 use=1`;
}

/** A TCP flow in the given state: the peer sent 5 MB, the engine 400 bytes of requests. */
function tcp(remote: string, state: string): string {
  return `ipv4     2 tcp      6 431999 ${state} src=${ENGINE} dst=${remote} sport=40000 dport=7764 packets=5 bytes=400 src=${remote} dst=198.51.100.2 sport=7764 dport=40000 packets=6 bytes=5000000 [ASSURED] mark=0 use=1`;
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
  it("counts connected peers and, as sending, only those that sent a block of data since the previous sample", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [53], () => 0);
    // A flow seen for the first time counts everything it moved so far: 1.1.1.1 sent a block, the
    // others a few bytes.
    tracker.update(
      parseConntrack(
        flows([
          [0, DATA_MIN_BYTES],
          [0, 1000],
          [0, 1000],
        ]),
      ),
    );
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, active: 1, countries: [{ code: "AU", count: 1 }] });

    // 8.8.8.8 sent a block since then, 9.9.9.9 one byte short of it, and 1.1.1.1 nothing.
    tracker.update(
      parseConntrack(
        flows([
          [0, DATA_MIN_BYTES],
          [0, 1000 + DATA_MIN_BYTES],
          [0, 1000 + DATA_MIN_BYTES - 1],
        ]),
      ),
    );
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, active: 1, countries: [{ code: "US", count: 1 }] });
  });

  it("doesn't count what every connection carries as sending: acknowledgements, short answers, closing flows", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [53], () => 0);
    const traffic = [
      // The engine uploads 2 MB to 1.1.1.1, which answers with acknowledgements: more than a block,
      // but no stream data.
      udp("1.1.1.1", 70_000, 8621, 2_000_000),
      // A UDP tracker's answer and a DHT node's: a few hundred bytes, on ports no filter knows.
      udp("8.8.8.8", 600, 6969, 100),
      udp("9.9.9.9", 300, 51_413, 100),
      // A peer that sent 5 MB and is closing, one that reset the connection, and one that sent as
      // much on an established connection.
      tcp("93.184.216.34", "FIN_WAIT"),
      tcp("93.184.216.35", "CLOSE"),
      tcp("93.184.216.36", "ESTABLISHED"),
    ].join("\n");
    tracker.update(parseConntrack(traffic));
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 4, active: 1, uploading: 1 });
    // The same counters again: nothing moved since the previous sample.
    tracker.update(parseConntrack(traffic));
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 4, active: 0, uploading: 0 });
  });

  it("counts a peer as sending once it sent a block on top of the share of what the engine sent it", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [], () => 0);
    tracker.update(
      parseConntrack(
        flows([
          [0, 0],
          [0, 0],
          [0, 0],
        ]),
      ),
    );
    // 1.1.1.1 sent 4 MB and got requests and acknowledgements back, 3% of that. 8.8.8.8 and 9.9.9.9
    // were each sent 2 MB. 8.8.8.8 sent 2 MB too, and 9.9.9.9 a block less one byte on top of the
    // share of it that replies may make up.
    const download = 4_000_000;
    const both = 2_000_000;
    const share = both * REPLY_SHARE;
    tracker.update(
      parseConntrack(
        flows([
          [120_000, download],
          [both, both],
          [both, share + DATA_MIN_BYTES - 1],
        ]),
      ),
    );
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, active: 2, uploading: 2 });

    // 9.9.9.9 sends the block it was short of, and the others nothing more.
    tracker.update(
      parseConntrack(
        flows([
          [120_000, download],
          [both, both],
          [both * 2, share * 2 + DATA_MIN_BYTES * 2 - 1],
        ]),
      ),
    );
    expect(tracker.get(ENGINE)).toMatchObject({ active: 1, uploading: 1 });
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
          [100 + DATA_MIN_BYTES, 1000],
          [50_000 + both * REPLY_SHARE + DATA_MIN_BYTES, 1000 + both],
        ]),
      ),
    );
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, uploading: 2 });

    // One byte short of a block, or of a block beyond the replies, doesn't count.
    tracker.update(
      parseConntrack(
        flows([
          [100 + replies, 1000 + download],
          [100 + 2 * DATA_MIN_BYTES - 1, 1000],
          [50_000 + both * REPLY_SHARE * 2 + DATA_MIN_BYTES * 2 - 1, 1000 + both * 2],
        ]),
      ),
    );
    expect(tracker.get(ENGINE)).toMatchObject({ uploading: 0 });
  });

  it("ranks the countries of the peers that sent data, and none when nobody did, not those of every connection", () => {
    const tracker = new PeerTracker(runner, geo, "172.31.250.0/24", [], () => 0);
    const traffic = flows([
      [0, 1000],
      [0, DATA_MIN_BYTES],
      [0, 1000],
    ]);
    // 8.8.8.8 (US) sends, the others (AU, CH) only answer.
    tracker.update(parseConntrack(traffic));
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, active: 1, countries: [{ code: "US", count: 1 }] });

    // Nobody sends: no countries, and the peers are still connected. The list doesn't switch to the
    // countries of every connection.
    tracker.update(parseConntrack(traffic));
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 3, active: 0, countries: [] });
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

/** A flow from one of the engine's ports to a peer, with the bytes the engine sent and received on it. */
function flow(remote: string, port: number, sent: number, received: number): string {
  return `udp      17 29 src=${ENGINE} dst=${remote} sport=${String(port)} dport=8621 packets=10 bytes=${String(sent)} src=${remote} dst=198.51.100.2 sport=8621 dport=${String(port)} packets=12 bytes=${String(received)} mark=0 use=1`;
}

/** A tracker on a clock the test moves, and its one engine's peers. */
function trafficSetup(ignoredPorts: number[] = []) {
  const clock = { now: 0 };
  /** What `conntrack -L` prints at the next poll, and its exit code. */
  const table = { stdout: "", code: 0 };
  const listing: CommandRunner = { run: () => Promise.resolve({ ...table, stderr: "" }) };
  const tracker = new PeerTracker(listing, geo, "172.31.250.0/24", ignoredPorts, () => clock.now);
  const sample = (seconds: number, lines: string[]): void => {
    clock.now = seconds * 1000;
    tracker.update(parseConntrack(lines.join("\n")));
  };
  /** A sample as the gateway takes it, through the command; `failed` is one whose command exited with an error. */
  const poll = async (seconds: number, lines: string[], failed = false): Promise<void> => {
    clock.now = seconds * 1000;
    table.stdout = lines.join("\n");
    table.code = failed ? 1 : 0;
    await tracker.poll();
  };
  const peers = () => tracker.traffic().find(({ ip }) => ip === ENGINE)?.peers;
  return { tracker, sample, poll, peers };
}

describe("PeerTracker.traffic", () => {
  it("adds up what the engine exchanged with each peer that answered, over all its flows, and how fast since the previous sample", () => {
    const { tracker, sample, peers } = trafficSetup();
    sample(0, [
      flow("1.1.1.1", 1000, 1000, 50_000),
      flow("1.1.1.1", 1001, 200, 10_000),
      // Never answered: no peer, however much the engine sent it.
      flow("8.8.8.8", 1002, 30_000, 0),
      flow("5.5.5.5", 1003, 100, 20_000),
    ]);
    // A flow seen for the first time counts with all it moved so far, but that says nothing of how
    // fast it moves now: after a gateway restart, every flow is new.
    expect(tracker.traffic()).toEqual([
      {
        ip: ENGINE,
        peers: [
          {
            ip: "1.1.1.1",
            country: "AU",
            downBytes: 60_000,
            upBytes: 1200,
            downBytesPerSecond: 0,
            upBytesPerSecond: 0,
          },
          {
            ip: "5.5.5.5",
            country: null,
            downBytes: 20_000,
            upBytes: 100,
            downBytesPerSecond: 0,
            upBytesPerSecond: 0,
          },
        ],
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
    ]);

    sample(5, [
      // 100 000 bytes more from the peer and 2000 more to it, in 5 seconds.
      flow("1.1.1.1", 1000, 3000, 150_000),
      flow("1.1.1.1", 1001, 200, 10_000),
      // A new flow of the same peer: in its totals, not in its speeds.
      flow("1.1.1.1", 1004, 50, 5000),
      // It answered: everything the engine sent it counts from here on.
      flow("8.8.8.8", 1002, 30_600, 500),
      flow("5.5.5.5", 1003, 100, 20_000),
    ]);
    // Most traffic first.
    expect(peers()).toEqual([
      {
        ip: "1.1.1.1",
        country: "AU",
        downBytes: 165_000,
        upBytes: 3250,
        downBytesPerSecond: 20_000,
        upBytesPerSecond: 400,
      },
      {
        ip: "8.8.8.8",
        country: "US",
        downBytes: 500,
        upBytes: 30_600,
        downBytesPerSecond: 100,
        upBytesPerSecond: 120,
      },
      { ip: "5.5.5.5", country: null, downBytes: 20_000, upBytes: 100, downBytesPerSecond: 0, upBytesPerSecond: 0 },
    ]);
    expect(tracker.traffic()[0]?.updatedAt).toBe("1970-01-01T00:00:05.000Z");
  });

  it("lists a peer only once it and the engine exchanged a block, both ways taken together", () => {
    const { tracker, sample, peers } = trafficSetup();
    // The short answers of a tracker or a DHT node, and a peer that only shook hands.
    sample(0, [flow("9.9.9.9", 2000, 300, 400), flow("1.1.1.1", 1000, 6000, PEER_MIN_BYTES - 6001)]);
    // The engine is listed: the table counts its connections.
    expect(tracker.traffic()).toEqual([{ ip: ENGINE, peers: [], updatedAt: "1970-01-01T00:00:00.000Z" }]);

    // One byte more, and it is a peer, with all that it moved before.
    sample(5, [flow("9.9.9.9", 2000, 300, 400), flow("1.1.1.1", 1000, 6000, PEER_MIN_BYTES - 6000)]);
    expect(peers()).toEqual([
      {
        ip: "1.1.1.1",
        country: "AU",
        downBytes: PEER_MIN_BYTES - 6000,
        upBytes: 6000,
        downBytesPerSecond: 0,
        upBytesPerSecond: 0,
      },
    ]);
  });

  it("keeps a peer's totals for as long as it has a flow in the table, and starts over once it had none", () => {
    const { sample, peers } = trafficSetup();
    const other = flow("9.9.9.9", 2000, 100, 20_000);
    sample(0, [flow("1.1.1.1", 1000, 1000, 50_000), other]);
    expect(peers()?.[0]).toMatchObject({ ip: "1.1.1.1", downBytes: 50_000, upBytes: 1000 });

    // Its flow went and another one came: the peer's totals go on.
    sample(5, [flow("1.1.1.1", 1001, 100, 2000), other]);
    expect(peers()?.[0]).toMatchObject({ ip: "1.1.1.1", downBytes: 52_000, upBytes: 1100 });

    // Lower counters between the same two ports are a new connection: what it moved is added, all
    // of it since the previous sample.
    sample(10, [flow("1.1.1.1", 1001, 50, 500), other]);
    expect(peers()?.[0]).toEqual({
      ip: "1.1.1.1",
      country: "AU",
      downBytes: 52_500,
      upBytes: 1150,
      downBytesPerSecond: 100,
      upBytesPerSecond: 10,
    });

    // One lower counter is enough to tell a new connection, and the other one counts whole too:
    // the engine sent it 60 bytes, not the 10 more than it had sent on the connection before.
    sample(15, [flow("1.1.1.1", 1001, 60, 300), other]);
    expect(peers()?.[0]).toMatchObject({ ip: "1.1.1.1", downBytes: 52_800, upBytes: 1210 });

    // No flow of the peer is left: it is gone, and comes back from nothing.
    sample(20, [other]);
    expect(peers()?.map(({ ip }) => ip)).toEqual(["9.9.9.9"]);
    sample(25, [flow("1.1.1.1", 1002, 70, 30_000), other]);
    expect(peers()?.find(({ ip }) => ip === "1.1.1.1")).toMatchObject({ downBytes: 30_000, upBytes: 70 });
  });

  it("keeps the totals through a sample whose conntrack failed, and goes on from the last good one", async () => {
    const { tracker, poll, peers } = trafficSetup();
    const table = (sent: number, received: number): string[] => [flow("1.1.1.1", 1000, sent, received)];
    // With a second connection, which ends before the next sample: its bytes stay in the peer's total.
    await poll(0, [...table(1000, 50_000), flow("1.1.1.1", 1001, 500, 8000)]);
    await poll(5, table(2000, 150_000));
    expect(peers()?.[0]).toMatchObject({ downBytes: 158_000, upBytes: 2500, downBytesPerSecond: 20_000 });
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 1, active: 1 });

    // The command fails, and prints a part of the table or nothing: no counts and no speeds, since
    // nothing is known of the peers now, but what they moved so far stands.
    await poll(10, [], true);
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 0, active: null });
    expect(tracker.traffic()).toEqual([
      {
        ip: ENGINE,
        peers: [
          {
            ip: "1.1.1.1",
            country: "AU",
            downBytes: 158_000,
            upBytes: 2500,
            downBytesPerSecond: 0,
            upBytesPerSecond: 0,
          },
        ],
        updatedAt: "1970-01-01T00:00:05.000Z",
      },
    ]);

    // The next sample counts what the connection moved since the last good one, 10 seconds ago. A
    // failed sample taken for an empty table would have ended the peer's total, and this one would
    // start it over with the whole connection: 250 000 bytes, less than the peer sent in all.
    await poll(15, table(3000, 250_000));
    expect(peers()?.[0]).toEqual({
      ip: "1.1.1.1",
      country: "AU",
      downBytes: 258_000,
      upBytes: 3500,
      downBytesPerSecond: 10_000,
      upBytesPerSecond: 100,
    });
    expect(tracker.get(ENGINE)).toMatchObject({ connected: 1, active: 1 });
  });

  it("lists no engine without conntrack accounting, and none that the peer counts leave out", () => {
    const unaccounted = trafficSetup();
    unaccounted.sample(0, [flow("1.1.1.1", 1000, 1000, 50_000).replaceAll(/ packets=\d+ bytes=\d+/g, "")]);
    expect(unaccounted.tracker.get(ENGINE)).toMatchObject({ connected: 1, active: null });
    expect(unaccounted.tracker.traffic()).toEqual([]);

    // A private remote, an ignored port and a source that is no engine.
    const { tracker, sample } = trafficSetup([53]);
    sample(0, [
      flow("192.168.1.10", 1000, 1000, 50_000),
      udp("1.1.1.1", 50_000, 53),
      flow("8.8.8.8", 1001, 1000, 50_000).replace(`src=${ENGINE}`, "src=172.31.1.5"),
    ]);
    expect(tracker.traffic()).toEqual([]);
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
