import { describe, expect, it } from "bun:test";
import type { Metric, ScorecardCondition } from "./config";
import { type MetricResult, computeScore, passes, weightedScore } from "./score";
import type { Flag } from "./severity";

const metric = (key: string, auto_fail = false) => ({ key, auto_fail }) as Pick<Metric, "key" | "auto_fail">;
const condition = (condition_code: string, severity: ScorecardCondition["severity"], metric_key: string | null = null) => ({
  condition_code,
  enabled: true,
  severity,
  metric_key,
});
const CONDITIONS = [
  condition("CRITICAL_HALLUCINATION", "critical"),
  condition("IGNORED_STOP_REQUEST", "critical"),
  condition("CALL_ERROR", "critical"),
  condition("AGENT_LOOP", "major", "a"),
  condition("WRONG_LANGUAGE", "minor", "b"),
];
const scorecard = (auto_fail: string[] = [], pass_threshold = 40) => ({
  pass_threshold,
  metrics: ["a", "b", "c", "d"].map((k) => metric(k, auto_fail.includes(k))),
  conditions: CONDITIONS,
});
const judge = (code: string, evidence: unknown[] = [{ turns: [2] }]): Flag => ({ code, source: "judge", evidence });
/** `computeScore` without the per-flag outcome, for the tests about the score and the verdict. */
const verdict = (...args: Parameters<typeof computeScore>) => {
  const { flags: _, ...rest } = computeScore(...args);
  return rest;
};
const scored = (key: string, score: number, max = 10): MetricResult => ({ key, score, max, n_a: false });
const na = (key: string): MetricResult => ({ key, score: null, max: 10, n_a: true });
const even = { a: 25, b: 25, c: 25, d: 25 };

describe("computeScore (PRD §4.2)", () => {
  it("all applicable: 100 × Σ w·s/m ÷ Σ w", () => {
    // 40·1 + 30·0.5 + 20·0.8 + 10·0.6 = 77
    const results = [scored("a", 10), scored("b", 5), scored("c", 8), scored("d", 6)];
    expect(verdict(results, { a: 40, b: 30, c: 20, d: 10 }, scorecard())).toEqual({ score: 77, passed: true, failedBy: [] });
  });

  it("each metric is normalised by its own maximum", () => {
    expect(verdict([scored("a", 3, 5), scored("b", 15, 20)], { a: 50, b: 50 }, scorecard()).score).toBe(67.5);
  });

  it("N/A metrics drop out and the remaining weights are re-normalised", () => {
    const results = [scored("a", 10), scored("b", 5), na("c"), na("d")];
    expect(verdict(results, { a: 30, b: 10, c: 40, d: 20 }, scorecard()).score).toBe(87.5);
  });

  it("weight 0 (or no weight) drops a metric out, and its 0 doesn't auto-fail the call", () => {
    const results = [scored("a", 8), scored("b", 4), scored("c", 0)];
    expect(verdict(results, { a: 50, b: 50, c: 0 }, scorecard(["c"]))).toEqual({ score: 60, passed: true, failedBy: [] });
    expect(verdict(results, { a: 50, b: 50 }, scorecard(["c"]))).toEqual({ score: 60, passed: true, failedBy: [] });
  });

  it("all N/A: no score, and the call fails", () => {
    expect(verdict([na("a"), na("b")], even, scorecard())).toEqual({ score: null, passed: false, failedBy: [{ kind: "no_score" }] });
  });

  it("rounds to one decimal and checks the threshold on the rounded score", () => {
    // 39.999 is shown as 40.0, so it passes; 39.9 fails.
    const at40 = verdict([scored("a", 3.9996), scored("b", 4), scored("c", 4), scored("d", 4)], even, scorecard());
    expect(at40).toEqual({ score: 40, passed: true, failedBy: [] });
    const at399 = verdict([scored("a", 3.96), scored("b", 4), scored("c", 4), scored("d", 4)], even, scorecard());
    expect(at399).toEqual({ score: 39.9, passed: false, failedBy: [{ kind: "below_threshold" }] });
  });

  it("exactly at the threshold passes", () => {
    const results = [scored("a", 4), scored("b", 4), scored("c", 4), scored("d", 4)];
    expect(verdict(results, even, scorecard())).toEqual({ score: 40, passed: true, failedBy: [] });
  });

  it("a metric that isn't N/A but has no score (nothing came back for it) drops out like N/A", () => {
    const results = [scored("a", 10), { key: "b", score: null, max: 10, n_a: false }];
    expect(weightedScore(results, { a: 50, b: 50 })).toBe(100);
  });

  it("a clean call with no failure condition that scores 35 fails", () => {
    const results = [scored("a", 3.5), scored("b", 3.5), scored("c", 3.5), scored("d", 3.5)];
    expect(verdict(results, even, scorecard())).toEqual({ score: 35, passed: false, failedBy: [{ kind: "below_threshold" }] });
  });

  it("uses the scorecard's threshold", () => {
    const results = [scored("a", 5), scored("b", 5), scored("c", 5), scored("d", 5)];
    expect(verdict(results, even, scorecard([], 60)).passed).toBe(false);
    expect(verdict(results, even, scorecard([], 50)).passed).toBe(true);
  });

  it("an auto-fail metric at 0 fails a call that scores 75", () => {
    const results = [scored("a", 0), scored("b", 10), scored("c", 10), scored("d", 10)];
    expect(verdict(results, even, scorecard(["a"]))).toEqual({
      score: 75,
      passed: false,
      failedBy: [{ kind: "auto_fail", metric: "a" }],
    });
    // Not auto-fail, or auto-fail but N/A: passes.
    expect(verdict(results, even, scorecard()).passed).toBe(true);
    expect(verdict([na("a"), scored("b", 10)], even, scorecard(["a"])).passed).toBe(true);
  });

  it("a Critical failure flag fails a call that scores 90", () => {
    const results = [scored("a", 9), scored("b", 9), scored("c", 9), scored("d", 9)];
    expect(verdict(results, even, scorecard(), [judge("CRITICAL_HALLUCINATION")])).toEqual({
      score: 90,
      passed: false,
      failedBy: [{ kind: "critical", code: "CRITICAL_HALLUCINATION" }],
    });
  });

  it("lists every reason a call failed", () => {
    const results = [scored("a", 0), scored("b", 2), scored("c", 0), scored("d", 2)];
    expect(verdict(results, even, scorecard(["a", "c"]), [judge("IGNORED_STOP_REQUEST"), { code: "CALL_ERROR", source: "rule", evidence: [] }]).failedBy).toEqual([
      { kind: "below_threshold" },
      { kind: "auto_fail", metric: "a" },
      { kind: "auto_fail", metric: "c" },
      { kind: "critical", code: "IGNORED_STOP_REQUEST" },
      { kind: "critical", code: "CALL_ERROR" },
    ]);
  });

  it("weightedScore and passes on their own (P0-6)", () => {
    expect(weightedScore([scored("a", 10), na("b")], { a: 10, b: 90 })).toBe(100);
    expect(weightedScore([na("a")], { a: 100 })).toBeNull();
    expect(passes(40, 40, false, false)).toBe(true);
    expect(passes(39.9, 40, false, false)).toBe(false);
    expect(passes(95, 40, true, false)).toBe(false);
    expect(passes(95, 40, false, true)).toBe(false);
    expect(passes(null, 40, false, false)).toBe(false);
  });
});

describe("computeScore with failure-condition severity (PRD §4.5)", () => {
  const nines = [scored("a", 9), scored("b", 9), scored("c", 9), scored("d", 9)];

  it("Critical fails the call whatever the score", () => {
    expect(computeScore(nines, even, scorecard(), [judge("CRITICAL_HALLUCINATION")])).toMatchObject({
      score: 90,
      passed: false,
      failedBy: [{ kind: "critical", code: "CRITICAL_HALLUCINATION" }],
      flags: { critical: ["CRITICAL_HALLUCINATION"] },
    });
  });

  it("Major zeroes the linked metric: the score drops, and the call still passes above the threshold", () => {
    // a zeroed: (0 + 9 + 9 + 9) / 4 = 67.5
    expect(computeScore(nines, even, scorecard(), [judge("AGENT_LOOP")])).toEqual({
      score: 67.5,
      passed: true,
      failedBy: [],
      flags: { critical: [], major: [{ code: "AGENT_LOOP", metric: "a" }], minor: [], dropped: [] },
    });
  });

  it("Major on an auto-fail metric fails the call through that metric", () => {
    expect(verdict(nines, even, scorecard(["a"]), [judge("AGENT_LOOP")])).toEqual({
      score: 67.5,
      passed: false,
      failedBy: [{ kind: "auto_fail", metric: "a" }],
    });
  });

  it("Minor is counted with no effect on the score or the verdict", () => {
    expect(computeScore(nines, even, scorecard(), [judge("WRONG_LANGUAGE")])).toEqual({
      score: 90,
      passed: true,
      failedBy: [],
      flags: { critical: [], major: [], minor: ["WRONG_LANGUAGE"], dropped: [] },
    });
  });

  it("a flag without evidence is dropped and changes nothing", () => {
    expect(computeScore(nines, even, scorecard(), [judge("CRITICAL_HALLUCINATION", []), judge("AGENT_LOOP", [])])).toEqual({
      score: 90,
      passed: true,
      failedBy: [],
      flags: {
        critical: [],
        major: [],
        minor: [],
        dropped: [
          { code: "CRITICAL_HALLUCINATION", reason: "no_evidence" },
          { code: "AGENT_LOOP", reason: "no_evidence" },
        ],
      },
    });
  });
});
