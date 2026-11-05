import { describe, expect, it } from "bun:test";
import type { GoldenRow } from "./golden";
import { judgeReport } from "./judge-report";

const NOW = new Date("2026-11-05T10:00:00Z");
const LABELS = { AGENT_LOOP: "Stuck in a loop", CRITICAL_HALLUCINATION: "Stated false facts" };
const check = (result: string) => ({ result, reason: "", evidence: [], rule: null, judge: null, flags: [] });

/** A stored audit: passed, goal achieved, Repetition 8/10, and these flags. */
const audit = (flags: string[] = [], prompt = "v2-3") =>
  ({
    passed: true,
    business_goal: { outcome: "ACHIEVED" },
    flags: flags.map((code) => ({ code, severity: "major" })),
    metrics: [{ key: "repetition", name: "Repetition", score: 8, max: 10, n_a: false, source: "judge" }],
    checks: { S1: check("PASS"), S2: check("PASS"), S3: check("PASS"), S4: check("NOT_APPLICABLE") },
    judge: { prompt_version: prompt },
  }) as unknown as GoldenRow["audit"];

const row = (call_id: number, r: Partial<GoldenRow> = {}): GoldenRow => ({
  review_id: call_id,
  audit_id: call_id,
  call_id,
  agent_code: "caller",
  kind: "normal",
  verdict: "agree",
  note: null,
  created_at: NOW.toISOString(),
  in_golden_set: true,
  expected_pass_fail: null,
  expected_business_outcome: null,
  expected_failure_codes: null,
  corrected_scores: null,
  corrected_checks: null,
  audit: audit(),
  ...r,
});
const blind = (call_id: number, r: Partial<GoldenRow> = {}) =>
  row(call_id, { kind: "blind", expected_pass_fail: "PASS", expected_business_outcome: "ACHIEVED", expected_failure_codes: [], ...r });
const param = (report: ReturnType<typeof judgeReport>, key: string) => report.parameters.find((p) => p.key === key);

describe("judgeReport", () => {
  it("compares each reviewer's answer with the audit they reviewed, lowest agreement first", () => {
    const report = judgeReport(
      [
        row(1, { verdict: "dispute", expected_business_outcome: "NOT_ACHIEVED", corrected_scores: { repetition: 3 } }),
        row(2),
        blind(3, { expected_pass_fail: "FAIL" }),
        blind(4),
      ],
      LABELS,
      NOW,
    );
    expect(report).toMatchObject({ generated_at: NOW.toISOString(), calls: 4, blind_calls: 2, judge_prompt_versions: ["v2-3"] });
    expect(param(report, "pass_fail")).toMatchObject({ agree: 3, total: 4, rate: 0.75 });
    expect(param(report, "business_outcome")).toMatchObject({ agree: 3, total: 4 });
    expect(param(report, "failure_codes")).toMatchObject({ agree: 4, total: 4 });
    // Metrics and checks exist only on normal reviews: a blind answer doesn't give them.
    expect(param(report, "metric:repetition")).toMatchObject({ label: "Repetition", agree: 1, total: 2 });
    expect(param(report, "check:S2")).toMatchObject({ label: "S2 Conversation handled", agree: 2, total: 2 });
    expect(report.parameters[0]!.key).toBe("metric:repetition");
    // 1/2 + 3/4 + 3/4 + 4/4 + 4 checks at 2/2 = 19 of 22 decisions.
    expect(report.overall).toEqual({ agree: 19, total: 22, rate: 19 / 22 });
    // Blind only: pass/fail 1/2, outcome 2/2, failure codes 2/2.
    expect(report.blind).toEqual({ agree: 5, total: 6, rate: 5 / 6 });
  });

  it("agreement on a metric allows one scale point", () => {
    const report = judgeReport([row(1, { verdict: "dispute", corrected_scores: { repetition: 7 } })], LABELS, NOW);
    expect(param(report, "metric:repetition")?.rate).toBe(1);
  });

  it("names weak parameters only from 5 calls up, with their base", () => {
    const small = judgeReport([blind(1, { expected_pass_fail: "FAIL" })], LABELS, NOW);
    expect(small.insights[0]).toBe("No parameter with at least 5 calls is below 85%.");

    const rows = [1, 2, 3, 4, 5, 6].map((id) => blind(id, { expected_pass_fail: id <= 3 ? "FAIL" : "PASS" }));
    const report = judgeReport(rows, LABELS, NOW);
    expect(report.insights[0]).toBe("Needs improvement: Pass/fail (50%, 3 of 6).");
    expect(param(report, "pass_fail")?.needs_improvement).toBe(true);
    expect(param(report, "failure_codes")?.needs_improvement).toBe(false);
    expect(param(small, "pass_fail")?.needs_improvement).toBe(false); // 0% on one call isn't a finding
  });

  it("says which failure conditions were flagged wrongly or missed, by their labels", () => {
    const report = judgeReport(
      [blind(1, { audit: audit(["AGENT_LOOP"]) }), blind(2, { expected_failure_codes: ["CRITICAL_HALLUCINATION"] }), blind(3, { audit: audit(["AGENT_LOOP"]), expected_failure_codes: ["AGENT_LOOP"] })],
      LABELS,
      NOW,
    );
    expect(report.insights).toContain("Stuck in a loop was flagged wrongly in 1 of 2 flagged calls.");
    expect(report.insights).toContain("Stated false facts was missed in 1 of 1 calls where reviewers found it.");
  });

  it("warns about a small set, about reviews made after seeing the audit, and about the gate", () => {
    const report = judgeReport([row(1), blind(2)], LABELS, NOW);
    expect(report.insights).toContain("Early signal: only 2 Golden Set calls, and these numbers settle at about 30.");
    expect(report.insights).toContain("1 of 2 calls were reviewed after seeing the audit, which can lift agreement. Blind spot-checks are the independent measure.");
    expect(report.insights).toContain("Switch-over gate not met yet: 1 of 30 blind spot-checks, and it needs 85% agreement.");
    expect(report.gate_met).toBe(false);
  });

  it("reports the gate as met at 30 agreeing blind checks", () => {
    const report = judgeReport(Array.from({ length: 30 }, (_, i) => blind(i + 1)), LABELS, NOW);
    expect(report.gate_met).toBe(true);
    expect(report.insights).toContain("The switch-over gate is met on these blind spot-checks, as audited.");
    expect(report.insights.some((i) => i.startsWith("Early signal"))).toBe(false);
    expect(report.early_signal).toBe(false);
  });

  it("30 blind checks don't meet the gate when agreement is under 85%", () => {
    const report = judgeReport(Array.from({ length: 30 }, (_, i) => blind(i + 1, { expected_pass_fail: i < 10 ? "FAIL" : "PASS" })), LABELS, NOW);
    expect(report.gate_met).toBe(false);
    expect(param(report, "pass_fail")).toMatchObject({ needs_improvement: true });
  });

  it("flags an early signal only with some calls and under 30", () => {
    expect(judgeReport([row(1)], LABELS, NOW).early_signal).toBe(true);
    expect(judgeReport([], LABELS, NOW).early_signal).toBe(false);
  });

  it("an audit where the judge gave no usable answer only counts what it decided", () => {
    const empty = { ...audit(), passed: null, business_goal: null, metrics: [] } as unknown as GoldenRow["audit"];
    const report = judgeReport([row(1, { audit: empty }), blind(2, { audit: empty })], LABELS, NOW);
    // The normal review has nothing to compare; the blind answer disagrees with "no verdict".
    expect(param(report, "pass_fail")).toMatchObject({ agree: 0, total: 1 });
    expect(param(report, "business_outcome")).toMatchObject({ agree: 0, total: 1 });
    expect(report.calls).toBe(2);
  });

  it("names several prompt versions when the audits ran on them", () => {
    expect(judgeReport([row(1, { audit: audit([], "v2-3") }), row(2, { audit: audit([], "v2-1") })], LABELS, NOW).judge_prompt_versions).toEqual(["v2-1", "v2-3"]);
  });

  it("an empty set prints no rates, and a row without a stored audit isn't measured", () => {
    const report = judgeReport([row(1, { audit: null })], LABELS, NOW);
    expect(report).toMatchObject({ calls: 0, overall: { rate: null }, blind: { rate: null }, parameters: [], judge_prompt_versions: [] });
    expect(report.insights).toEqual(["Switch-over gate not met yet: 0 of 30 blind spot-checks, and it needs 85% agreement."]);
  });
});
