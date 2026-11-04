import { describe, expect, it } from "bun:test";
import { disputeInput, newItem, sortMetrics, unchangedItems, type DisputeItem } from "../../../dashboard/src/lib/v2-logic";
import { type ReviewTarget, validateReview } from "./review";

/**
 * The dashboard's dispute dialog (`dashboard/src/lib/v2-logic.ts`) builds the review the server then checks with
 * `validateReview`. These run both sides on one audit, so the two can't drift apart.
 */

const metric = (key: string, score: number | null, extra: Record<string, unknown> = {}) => ({
  key,
  name: key.replace("_", " "),
  score,
  max: 10,
  n_a: score === null,
  source: "judge" as const,
  reason: "",
  evidence: [],
  zeroed_by: null,
  ...extra,
});
const check = (result: "PASS" | "FAIL" | "NOT_APPLICABLE") => ({ result, reason: "", evidence: [], rule: null, judge: null });

const view = {
  audit: {
    id: 1,
    result: {
      metrics: [metric("repetition", 6, { zeroed_by: "AGENT_LOOP" }), metric("flow_adherence", 9), metric("troubleshooting", null), metric("query_handling", 3)],
      checks: { S1: check("PASS"), S2: check("FAIL"), S3: check("PASS"), S4: check("NOT_APPLICABLE") },
      business_goal: { outcome: "ACHIEVED", reason_code: "X", reason: "", evidence: [], required_outputs: [] },
      flags: [{ code: "AGENT_LOOP", source: "judge", severity: "major", reason: "", evidence: [] }],
    },
  },
  context: { conditions: [], goal: { outcomes: ["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"] } },
} as any;

/** The same audit as the server sees it. */
const target: ReviewTarget = {
  metrics: view.audit.result.metrics,
  checks: view.audit.result.checks,
  business_outcome: "ACHIEVED",
  outcomes: ["ACHIEVED", "NOT_ACHIEVED", "NOT_APPLICABLE"],
  failure_codes: ["AGENT_LOOP"],
  known_codes: ["AGENT_LOOP", "CRITICAL_HALLUCINATION", "CALL_ERROR", "NO_AGENT_SPEECH"],
};

const set = (item: DisputeItem, patch: Partial<DisputeItem>) => ({ ...item, ...patch }) as DisputeItem;

describe("dispute dialog → review (P2-4)", () => {
  it("new items start at the audit's answer, so they dispute nothing until changed", () => {
    const items = ["metric:query_handling", "metric:troubleshooting", "check:S2", "business_outcome"].map((k) => newItem(k, view));
    expect(items.map((i) => ("value" in i ? i.value : null))).toEqual(["3", "na", "FAIL", "ACHIEVED"]);
    expect(unchangedItems(items, view)).toHaveLength(4);
    expect(unchangedItems([newItem("code:AGENT_LOOP", view)], view)).toEqual([]); // naming a code always disputes it
  });

  it("builds the full right failure-code list and per-item notes; the server accepts it", () => {
    const items = [
      set(newItem("metric:query_handling", view), { value: "7", note: "Answered at turn 12." }),
      set(newItem("check:S2", view), { value: "PASS" }),
      set(newItem("business_outcome", view), { value: "NOT_ACHIEVED" }),
      set(newItem("code:AGENT_LOOP", view), { note: "Re-asked after noise, not a loop." }), // flagged → remove
      set(newItem("code:CRITICAL_HALLUCINATION", view), { note: "Invented a salary." }), // not flagged → add
    ];
    const input = disputeInput(items, view, "  Two problems.  ");
    expect(input).toEqual({
      verdict: "dispute",
      note: "Two problems.",
      corrected_scores: { query_handling: 7 },
      corrected_checks: { S2: "PASS" },
      expected_business_outcome: "NOT_ACHIEVED",
      expected_failure_codes: ["CRITICAL_HALLUCINATION"],
      item_notes: {
        "metric:query_handling": "Answered at turn 12.",
        "code:AGENT_LOOP": "Re-asked after noise, not a loop.",
        "code:CRITICAL_HALLUCINATION": "Invented a salary.",
      },
    });
    expect(validateReview(input, target)).toEqual([]);
  });

  it("sends N/A as null, and removing the only flag sends an empty list", () => {
    const input = disputeInput([set(newItem("metric:flow_adherence", view), { value: "na" }), newItem("code:AGENT_LOOP", view)], view, "");
    expect(input.corrected_scores).toEqual({ flow_adherence: null });
    expect(input.expected_failure_codes).toEqual([]);
    expect(input.note).toBeNull();
    expect(input.item_notes).toBeUndefined();
    expect(validateReview(input, target)).toEqual([]);
  });

  it("a dispute with nothing changed is refused by the server too", () => {
    const input = disputeInput([newItem("check:S2", view)], view, "");
    expect(validateReview(input, target)).toEqual(["a dispute must change at least one item; to accept the audit, agree"]);
  });
});

describe("scorecard order (P2-1)", () => {
  it("lowest share first, a zeroed metric as 0, N/A last", () => {
    expect(sortMetrics(view.audit.result.metrics).map((m: { key: string }) => m.key)).toEqual(["repetition", "query_handling", "flow_adherence", "troubleshooting"]);
  });
});
