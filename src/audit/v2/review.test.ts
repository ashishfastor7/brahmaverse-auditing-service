import { describe, expect, it } from "bun:test";
import { disputedItems, type ReviewTarget, validateReview } from "./review";

const target: ReviewTarget = {
  metrics: [
    { key: "repetition", max: 10, score: 2, n_a: false },
    { key: "flow_adherence", max: 10, score: 9, n_a: false },
    { key: "troubleshooting", max: 10, score: null, n_a: true },
  ],
  checks: { S1: { result: "PASS" }, S2: { result: "FAIL" }, S3: { result: "PASS" }, S4: { result: "NOT_APPLICABLE" } },
  business_outcome: "ACHIEVED",
  outcomes: ["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"],
  failure_codes: ["AGENT_LOOP"],
  known_codes: ["AGENT_LOOP", "CRITICAL_HALLUCINATION", "CALL_ERROR", "NO_AGENT_SPEECH"],
};

describe("validateReview (P2-4)", () => {
  it("agree and flag take a note and nothing else", () => {
    expect(validateReview({ verdict: "agree" }, target)).toEqual([]);
    expect(validateReview({ verdict: "flag", note: "Check the recording." }, target)).toEqual([]);
    expect(validateReview({ verdict: "agree", corrected_scores: { repetition: 5 } }, target)).toEqual(["an agree review can't correct anything; dispute instead"]);
    expect(validateReview({ verdict: "flag", item_notes: { "metric:repetition": "x" } }, target)).toEqual(["a flag review has no item notes; use the note"]);
  });

  it("one dispute can correct a metric, a check, the outcome and the failure codes, each with a note", () => {
    const review = {
      verdict: "dispute" as const,
      corrected_scores: { repetition: 8, troubleshooting: null },
      corrected_checks: { S2: "PASS" as const },
      expected_business_outcome: "NOT_ACHIEVED" as const,
      expected_failure_codes: ["CRITICAL_HALLUCINATION"], // "this wasn't a loop", "this was a hallucination"
      item_notes: { "metric:repetition": "Re-asked after noise.", "code:AGENT_LOOP": "Not a loop.", "code:CRITICAL_HALLUCINATION": "Invented a salary." },
    };
    expect(validateReview(review, target)).toEqual([]);
    expect(disputedItems(review, target)).toEqual(["metric:repetition", "check:S2", "business_outcome", "code:AGENT_LOOP", "code:CRITICAL_HALLUCINATION"]);
  });

  it("a dispute must change something, and notes go only on disputed items", () => {
    expect(validateReview({ verdict: "dispute", corrected_scores: { repetition: 2 } }, target)).toEqual([
      "a dispute must change at least one item; to accept the audit, agree",
    ]);
    expect(validateReview({ verdict: "dispute", corrected_scores: { repetition: 4 }, item_notes: { "check:S2": "x" } }, target)).toEqual([
      "notes on items that aren't disputed: check:S2",
    ]);
  });

  it("rejects unknown metrics, out-of-scale scores, bad checks, outcomes not offered and unknown codes", () => {
    expect(
      validateReview(
        {
          verdict: "dispute",
          corrected_scores: { pronunciation: 3, repetition: 11 },
          corrected_checks: { S5: "PASS" } as any,
          expected_business_outcome: "PARTIAL",
          expected_failure_codes: ["MADE_UP"],
        },
        target,
      ),
    ).toEqual([
      "metric pronunciation isn't part of this audit",
      "metric repetition must be scored 0 to 10, or N/A",
      "S5 isn't a system check",
      "PARTIAL isn't an outcome this agent's goal offers",
      "MADE_UP isn't a failure condition on this scorecard",
    ]);
  });
});
