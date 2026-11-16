import { describe, expect, it } from "vitest";
import { sharedEnginesHint } from "../src/hints.ts";

describe("sharedEnginesHint", () => {
  it("says an engine of its own when off", () => {
    expect(sharedEnginesHint(undefined)).toBe("Off: every stream has an engine of its own.");
    expect(sharedEnginesHint({ enabled: false, maxFailures: 2, failureWindowSeconds: 60 })).toContain("Off:");
  });

  it("lists every case that replaces a shared engine, with the configured limits", () => {
    const hint = sharedEnginesHint({ enabled: true, maxFailures: 3, failureWindowSeconds: 90 });
    expect(hint).toContain("replaced when a stream someone is watching fails");
    expect(hint).toContain("more than 3 of its streams fail within 90 s");
    expect(hint).toContain("every stream on it fails");
    expect(hint).toContain("stops answering");
    expect(hint).toContain("press Restart");
    expect(hint).not.toContain("only");
  });
});
