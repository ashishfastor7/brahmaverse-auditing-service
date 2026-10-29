import { describe, expect, it } from "bun:test";
import { goalRate } from "./business-goal";

describe("goalRate (P1-6, PRD §3.3)", () => {
  it("is achieved over applicable calls; N/A and unjudged audits are left out", () => {
    expect(goalRate(["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE", "ACHIEVED", null])).toEqual({ applicable: 3, rate: 66.7, partial_share: 0 });
  });

  it("does not count Partial as achieved, and reports its share next to the rate", () => {
    expect(goalRate(["ACHIEVED", "PARTIAL", "PARTIAL", "NOT_ACHIEVED"])).toEqual({ applicable: 4, rate: 25, partial_share: 50 });
  });

  it("is null when no call is applicable", () => {
    expect(goalRate(["NOT_APPLICABLE", null])).toEqual({ applicable: 0, rate: null, partial_share: null });
    expect(goalRate([])).toEqual({ applicable: 0, rate: null, partial_share: null });
  });
});
