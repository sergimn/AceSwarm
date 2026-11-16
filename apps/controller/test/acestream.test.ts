import { afterEach, describe, expect, it, vi } from "vitest";
import { AcestreamClient } from "../src/acestream.ts";

function answer(body: unknown): void {
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json(body)));
}

describe("AcestreamClient.stats", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the figures the engine reports", async () => {
    answer({
      response: { status: "dl", peers: 7, speed_down: 412, speed_up: 0, downloaded: 9000, uploaded: 0 },
      error: null,
    });
    await expect(new AcestreamClient().stats("http://engine/stat")).resolves.toEqual({
      status: "dl",
      peers: 7,
      speedDown: 412,
      speedUp: 0,
      downloaded: 9000,
      uploaded: 0,
    });
  });

  it("leaves a figure the engine did not report unknown, not 0", async () => {
    answer({ response: { status: "prebuf" }, error: null });
    await expect(new AcestreamClient().stats("http://engine/stat")).resolves.toEqual({
      status: "prebuf",
      peers: null,
      speedDown: null,
      speedUp: null,
      downloaded: null,
      uploaded: null,
    });
  });
});
