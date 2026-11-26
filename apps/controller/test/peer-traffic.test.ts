import type { EnginePeerTraffic, PeerTraffic } from "@aceswarm/shared/api-types";
import { describe, expect, test } from "vitest";
import { PeerBytesByPlace, PeerTrafficMonitor, type EngineLabels, type EnginePeers } from "../src/peer-traffic.ts";

const peer = (ip: string, downBytes: number, upBytes = 0, country: string | null = "ES"): PeerTraffic => ({
  ip,
  country,
  downBytes,
  upBytes,
  downBytesPerSecond: 0,
  upBytesPerSecond: 0,
});

test("keeps each engine's peers as the gateway last counted them, and has no answer once it doesn't answer", async () => {
  let answer: EnginePeerTraffic[] | Error = [
    { ip: "172.31.250.130", peers: [peer("1.1.1.1", 500)], updatedAt: "2026-11-26T12:00:00.000Z" },
    { ip: "172.31.250.131", peers: [], updatedAt: "2026-11-26T12:00:00.000Z" },
  ];
  const monitor = new PeerTrafficMonitor({
    peerTraffic: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  });
  // Before the first sample there is nothing to go by.
  expect(monitor.of("172.31.250.130")).toBeUndefined();

  await monitor.sample();
  expect(monitor.of("172.31.250.130")).toEqual([peer("1.1.1.1", 500)]);
  expect(monitor.of("172.31.250.131")).toEqual([]);
  // An engine the gateway doesn't list has no peers, which is an answer.
  expect(monitor.of("172.31.250.132")).toEqual([]);

  // An engine that went takes its peers with it.
  answer = [{ ip: "172.31.250.131", peers: [peer("8.8.8.8", 900)], updatedAt: "2026-11-26T12:00:05.000Z" }];
  await monitor.sample();
  expect(monitor.of("172.31.250.130")).toEqual([]);
  expect(monitor.of("172.31.250.131")).toEqual([peer("8.8.8.8", 900)]);

  // The gateway restarts, or is one that has no such answer yet: old figures would pass for current
  // ones, and "no peers" would pass for peers that left.
  answer = new Error("HTTP 404");
  await expect(monitor.sample()).rejects.toThrow("HTTP 404");
  expect(monitor.of("172.31.250.131")).toBeUndefined();
});

const IP = "172.31.250.130";
const PLAYING: EngineLabels = { stream: "s1", engine: "e1", role: "playing", path: "direct" };
const STANDBY: EngineLabels = { ...PLAYING, role: "standby" };

/** A scrape of one engine, as lines: its place, the peer, the direction and the bytes. */
function scrape(counted: PeerBytesByPlace, labels: EngineLabels, peers: readonly PeerTraffic[] | undefined): string[] {
  const engines: EnginePeers[] = [{ ip: IP, labels, peers }];
  return counted
    .collect(engines)
    .map(
      ({ labels: of, bytes }) =>
        `${of.engine} ${of.role} ${of.path} ${of.peer} ${of.country} ${of.direction} ${String(bytes)}`,
    );
}

/**
 * A scrape of one engine whose one peer sent it this much in all, as the gateway counts: the lines
 * of that direction. The peer's country is ES, or the one given: null while the gateway knows none.
 */
function scrapeDown(
  counted: PeerBytesByPlace,
  labels: EngineLabels,
  total: number,
  country: string | null = "ES",
): string[] {
  return scrape(counted, labels, [peer("1.1.1.1", total, 0, country)]).filter((line) => line.includes(" down "));
}

describe("PeerBytesByPlace", () => {
  test("counts from zero what the gateway's totals grow by, from the scrape that first sees a peer", () => {
    const counted = new PeerBytesByPlace();
    // The peers an engine is first seen with: what they moved until now is not counted, because a
    // controller that just started cannot tell how much of it the one before already counted.
    expect(scrape(counted, PLAYING, [peer("1.1.1.1", 50_000, 2000)])).toEqual([
      "e1 playing direct 1.1.1.1 ES down 0",
      "e1 playing direct 1.1.1.1 ES up 0",
    ]);
    // A second peer starts at zero too, also the way nothing moved yet.
    expect(scrape(counted, PLAYING, [peer("1.1.1.1", 80_000, 2500), peer("8.8.8.8", 20_000)])).toEqual([
      "e1 playing direct 1.1.1.1 ES down 30000",
      "e1 playing direct 1.1.1.1 ES up 500",
      "e1 playing direct 8.8.8.8 ES down 0",
      "e1 playing direct 8.8.8.8 ES up 0",
    ]);
    // A scrape that finds the same totals, such as two within one sample of the gateway, adds nothing.
    const third = [peer("1.1.1.1", 80_000, 2500), peer("8.8.8.8", 21_000, 300)];
    scrape(counted, PLAYING, third);
    expect(scrape(counted, PLAYING, third)).toEqual([
      "e1 playing direct 1.1.1.1 ES down 30000",
      "e1 playing direct 1.1.1.1 ES up 500",
      "e1 playing direct 8.8.8.8 ES down 1000",
      "e1 playing direct 8.8.8.8 ES up 300",
    ]);
  });

  test("an engine that changes its place and comes back counts every byte once, under the place it had", () => {
    const counted = new PeerBytesByPlace();
    scrapeDown(counted, PLAYING, 100_000);
    expect(scrapeDown(counted, PLAYING, 140_000)).toEqual(["e1 playing direct 1.1.1.1 ES down 40000"]);

    // A failover made it the standby. What moved since the scrape before still counts for the place
    // it had then, and the new place's series starts at zero: nothing is lost, and nothing is twice.
    expect(scrapeDown(counted, STANDBY, 150_000)).toEqual([
      "e1 playing direct 1.1.1.1 ES down 50000",
      "e1 standby direct 1.1.1.1 ES down 0",
    ]);
    // The series of the place it left stays where it is while the peer is listed.
    expect(scrapeDown(counted, STANDBY, 190_000)).toEqual([
      "e1 playing direct 1.1.1.1 ES down 50000",
      "e1 standby direct 1.1.1.1 ES down 40000",
    ]);

    // The next failover makes it the playing engine again. Its series goes on from where it was,
    // and does not jump by what the standby's counted: the gateway's total grew by 150 000 since
    // the first scrape, and the two series add up to that.
    expect(scrapeDown(counted, PLAYING, 200_000)).toEqual([
      "e1 playing direct 1.1.1.1 ES down 50000",
      "e1 standby direct 1.1.1.1 ES down 50000",
    ]);
    expect(scrapeDown(counted, PLAYING, 250_000)).toEqual([
      "e1 playing direct 1.1.1.1 ES down 100000",
      "e1 standby direct 1.1.1.1 ES down 50000",
    ]);
  });

  test("a peer whose country changes counts every byte once, under the country it had", () => {
    const counted = new PeerBytesByPlace();
    // The gateway has no country database yet, as on a new installation.
    scrapeDown(counted, PLAYING, 100_000, null);
    expect(scrapeDown(counted, PLAYING, 140_000, null)).toEqual(["e1 playing direct 1.1.1.1  down 40000"]);

    // Now it has. The series with the country starts at zero, like one of a new place, and what
    // moved since the scrape before counts for the one without.
    expect(scrapeDown(counted, PLAYING, 150_000)).toEqual([
      "e1 playing direct 1.1.1.1  down 50000",
      "e1 playing direct 1.1.1.1 ES down 0",
    ]);
    expect(scrapeDown(counted, PLAYING, 190_000)).toEqual([
      "e1 playing direct 1.1.1.1  down 50000",
      "e1 playing direct 1.1.1.1 ES down 40000",
    ]);

    // A country that comes back, as after a database the gateway could not read, goes on from where
    // its series was, and does not jump by what the other one counted.
    expect(scrapeDown(counted, PLAYING, 200_000, null)).toEqual([
      "e1 playing direct 1.1.1.1  down 50000",
      "e1 playing direct 1.1.1.1 ES down 50000",
    ]);
    expect(scrapeDown(counted, PLAYING, 230_000, null)).toEqual([
      "e1 playing direct 1.1.1.1  down 80000",
      "e1 playing direct 1.1.1.1 ES down 50000",
    ]);

    // A place and a country that change at once are one more series.
    expect(scrapeDown(counted, STANDBY, 240_000)).toEqual([
      "e1 playing direct 1.1.1.1  down 90000",
      "e1 playing direct 1.1.1.1 ES down 50000",
      "e1 standby direct 1.1.1.1 ES down 0",
    ]);
  });

  test("a peer that left starts at zero when it comes back, and a total that started over counts whole", () => {
    const counted = new PeerBytesByPlace();
    scrape(counted, PLAYING, [peer("1.1.1.1", 100_000), peer("8.8.8.8", 20_000)]);
    scrape(counted, PLAYING, [peer("1.1.1.1", 130_000), peer("8.8.8.8", 20_000)]);
    // Its connections left the gateway's table: its series go.
    expect(scrape(counted, PLAYING, [peer("8.8.8.8", 20_000)])).toEqual([
      "e1 playing direct 8.8.8.8 ES down 0",
      "e1 playing direct 8.8.8.8 ES up 0",
    ]);
    // Back, with a total the gateway started over: from zero again, which Prometheus takes for a
    // counter that was reset.
    const back = scrape(counted, PLAYING, [peer("1.1.1.1", 17_000), peer("8.8.8.8", 20_000)]);
    expect(back[0]).toBe("e1 playing direct 1.1.1.1 ES down 0");

    // It left and came back between two scrapes, or the gateway restarted: its total is lower than
    // before, and all of it moved since.
    expect(scrape(counted, PLAYING, [peer("1.1.1.1", 9000), peer("8.8.8.8", 26_000)])).toEqual([
      "e1 playing direct 1.1.1.1 ES down 9000",
      "e1 playing direct 1.1.1.1 ES up 0",
      "e1 playing direct 8.8.8.8 ES down 6000",
      "e1 playing direct 8.8.8.8 ES up 0",
    ]);
  });

  test("totals that started over count whole both ways, also the one that is not lower than before", () => {
    const counted = new PeerBytesByPlace();
    scrape(counted, PLAYING, [peer("1.1.1.1", 100_000, 5000), peer("8.8.8.8", 50_000, 7000)]);
    scrape(counted, PLAYING, [peer("1.1.1.1", 130_000, 6000), peer("8.8.8.8", 60_000, 8000)]);
    // The gateway's totals of both peers started over. The first sent less than its old total since
    // then and got more, the second the other way round: one lower total says that both are new,
    // and the higher one is not what the old one grew by.
    expect(scrape(counted, PLAYING, [peer("1.1.1.1", 20_000, 9000), peer("8.8.8.8", 70_000, 400)])).toEqual([
      "e1 playing direct 1.1.1.1 ES down 50000",
      "e1 playing direct 1.1.1.1 ES up 10000",
      "e1 playing direct 8.8.8.8 ES down 80000",
      "e1 playing direct 8.8.8.8 ES up 1400",
    ]);
    // From there they go on as ever.
    expect(scrape(counted, PLAYING, [peer("1.1.1.1", 25_000, 9500), peer("8.8.8.8", 70_000, 400)])).toEqual([
      "e1 playing direct 1.1.1.1 ES down 55000",
      "e1 playing direct 1.1.1.1 ES up 10500",
      "e1 playing direct 8.8.8.8 ES down 80000",
      "e1 playing direct 8.8.8.8 ES up 1400",
    ]);
  });

  test("keeps what is counted while the gateway has no answer, and catches up with the next one", () => {
    const counted = new PeerBytesByPlace();
    scrape(counted, PLAYING, [peer("1.1.1.1", 100_000)]);
    scrape(counted, PLAYING, [peer("1.1.1.1", 140_000)]);
    // No answer is not "no peers": nothing to show, and nothing forgotten.
    expect(scrape(counted, PLAYING, undefined)).toEqual([]);
    expect(scrape(counted, STANDBY, undefined)).toEqual([]);
    // What moved meanwhile counts for the place the engine had at the last scrape with an answer.
    expect(scrape(counted, STANDBY, [peer("1.1.1.1", 200_000)])).toEqual([
      "e1 playing direct 1.1.1.1 ES down 100000",
      "e1 playing direct 1.1.1.1 ES up 0",
      "e1 standby direct 1.1.1.1 ES down 0",
      "e1 standby direct 1.1.1.1 ES up 0",
    ]);
    // An engine that was never seen with an answer has nothing to keep.
    expect(scrape(new PeerBytesByPlace(), PLAYING, undefined)).toEqual([]);
  });

  test("forgets an engine that is gone, and takes a new container with its address for another engine", () => {
    const counted = new PeerBytesByPlace();
    scrape(counted, PLAYING, [peer("1.1.1.1", 100_000)]);
    scrape(counted, PLAYING, [peer("1.1.1.1", 140_000)]);
    // The stream's next engine got the address. The gateway's total still has what the old engine's
    // connections moved, which is not the new engine's traffic.
    const next: EngineLabels = { ...PLAYING, engine: "e2" };
    expect(scrape(counted, next, [peer("1.1.1.1", 150_000)])).toEqual([
      "e2 playing direct 1.1.1.1 ES down 0",
      "e2 playing direct 1.1.1.1 ES up 0",
    ]);
    expect(scrape(counted, next, [peer("1.1.1.1", 155_000)])[0]).toBe("e2 playing direct 1.1.1.1 ES down 5000");

    // An engine that was left out of a scrape, such as one without an address for a moment, starts over.
    expect(counted.collect([])).toEqual([]);
    expect(scrape(counted, next, [peer("1.1.1.1", 190_000)])[0]).toBe("e2 playing direct 1.1.1.1 ES down 0");
  });
});
