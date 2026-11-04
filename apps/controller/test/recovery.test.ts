import { describe, expect, it } from "vitest";
import { nextRecovery } from "../src/recovery.ts";

const POLICY = { baseDelayMs: 1000, maxDelayMs: 8000 };

function actions(count: number, canSwitchPath: boolean): string[] {
  return Array.from(
    { length: count },
    (_, failures) => nextRecovery({ failures, lastActionAt: 0 }, POLICY, canSwitchPath).action,
  );
}

describe("nextRecovery", () => {
  it("climbs from pipeline to engine to path", () => {
    expect(actions(7, true)).toEqual([
      "restart-pipeline",
      "restart-pipeline",
      "restart-engine",
      "switch-path",
      "restart-engine",
      "switch-path",
      "restart-engine",
    ]);
  });

  it("never switches path when there is nowhere to go", () => {
    expect(actions(6, false)).not.toContain("switch-path");
  });

  it("backs off exponentially up to the maximum", () => {
    const delays = [0, 1, 2, 3, 4, 5].map(
      (failures) => nextRecovery({ failures, lastActionAt: 100 }, POLICY, true).notBefore - 100,
    );
    expect(delays).toEqual([0, 1000, 2000, 4000, 8000, 8000]);
  });

  it("can act immediately the first time", () => {
    expect(nextRecovery({ failures: 0, lastActionAt: undefined }, POLICY, true).notBefore).toBe(0);
  });
});
