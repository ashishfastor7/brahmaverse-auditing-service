import { describe, expect, it } from "bun:test";
import { CODE_PATTERN, codeFromLabel, withDoesNotCount } from "./conditions";

describe("new condition helpers", () => {
  it("codeFromLabel: upper snake case, no stray underscores, at most 64 characters", () => {
    expect(codeFromLabel("Asked for the OTP")).toBe("ASKED_FOR_THE_OTP");
    expect(codeFromLabel("  Shared a competitor's price! ")).toBe("SHARED_A_COMPETITOR_S_PRICE");
    expect(codeFromLabel("x".repeat(80))).toHaveLength(64);
    expect(CODE_PATTERN.test(codeFromLabel("Asked for the OTP"))).toBe(true);
    expect(CODE_PATTERN.test("1_BAD")).toBe(false);
    expect(CODE_PATTERN.test("AB")).toBe(false);
  });

  it("withDoesNotCount: one sentence each, worded like the library", () => {
    expect(withDoesNotCount("The agent asked the caller to read out an OTP.", "the caller offered it unprompted")).toBe(
      "The agent asked the caller to read out an OTP. It does NOT count when the caller offered it unprompted.",
    );
    expect(withDoesNotCount("  The agent asked for an OTP  ", "When the caller offered it.")).toBe(
      "The agent asked for an OTP. It does NOT count when the caller offered it.",
    );
  });
});
