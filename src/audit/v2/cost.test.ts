import { describe, expect, it } from "bun:test";
import { judgeCost } from "./cost";

describe("judgeCost (P1-8)", () => {
  it("prices input and output tokens per million, to 6 decimals", () => {
    // 5,000 × $0.75 + 2,000 × $4.50 per 1M = $0.00375 + $0.009
    expect(judgeCost("gpt-5.4-mini-2026-03-17", { input_tokens: 5000, output_tokens: 2000 })).toBe(0.01275);
    expect(judgeCost("gpt-5.4-mini-2026-03-17", { input_tokens: 1, output_tokens: 0 })).toBe(0.000001);
  });

  it("is null for a model without a price", () => {
    expect(judgeCost("some-new-model-2027-01-01", { input_tokens: 5000, output_tokens: 2000 })).toBeNull();
  });
});
